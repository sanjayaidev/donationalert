import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { order_id, payment_id, razorpay_order_id, razorpay_signature, provider, name, email, message } = req.body;
  
  if (!order_id) {
    return res.status(400).json({ error: 'Missing order_id' });
  }

  // Determine provider from URL param or infer from presence of provider-specific fields
  const actualProvider = provider || 
                         (razorpay_signature ? 'razorpay' : 
                         (payment_id && payment_id.startsWith('PAYID') ? 'paypal' : 'cashfree'));

  try {
    if (actualProvider === 'razorpay') {
      return await verifyRazorpay(req, res);
    } else if (actualProvider === 'paypal') {
      return await verifyPaypal(req, res);
    } else {
      return await verifyCashfree(req, res);
    }
  } catch (err) {
    console.error(`[Verify Error] ${actualProvider}:`, err);
    return res.status(500).json({ error: err.message });
  }
}

async function verifyCashfree(req, res) {
  const { order_id, name, email, message } = req.body;
  
  // Validate credentials - use production or sandbox based on PRODUCTION_MODE
  const isTestMode = process.env.PRODUCTION_MODE !== 'true';
  const appId = (isTestMode && process.env.CASHFREE_SANDBOX_APP_ID) 
                ? process.env.CASHFREE_SANDBOX_APP_ID 
                : process.env.CASHFREE_APP_ID;
  const secretKey = (isTestMode && process.env.CASHFREE_SANDBOX_SECRET_KEY) 
                    ? process.env.CASHFREE_SANDBOX_SECRET_KEY 
                    : process.env.CASHFREE_SECRET_KEY;
  
  if (!appId || !secretKey) {
    return res.status(500).json({ 
      error: `Cashfree credentials not configured for ${isTestMode ? 'TEST' : 'PRODUCTION'} mode` 
    });
  }

  const cfBaseUrl = isTestMode ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';

  // Fetch order status from Cashfree
  const cfRes = await fetch(`${cfBaseUrl}/orders/${order_id}`, {
    headers: {
      'x-api-version': '2023-08-01',
      'x-client-id': appId,
      'x-client-secret': secretKey,
    },
  });
  const order = await cfRes.json();

  if (!cfRes.ok) {
    return res.status(502).json({ error: 'Cashfree error', detail: order });
  }

  const status = order.order_status;

  if (status !== 'PAID') {
    return res.status(200).json({ paid: false, status });
  }

  // Use verified data from Cashfree (priority over client-sent)
  const amount = order.order_amount;
  const custName = order.customer_details?.customer_name || name || 'Anonymous';
  const custEmail = order.customer_details?.customer_email || email || 'no@email.no';
  const tipMsg = order.order_tags?.message || message || 'Thanks for the tip!';

  // Send to StreamElements
  const seRes = await fetch(
    `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SE_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        user: {
          username: custName,
          userId: 'cf-' + order_id,
          email: custEmail,
        },
        provider: 'Cashfree',
        message: tipMsg,
        amount,
        currency: 'INR',
        imported: 'true',
      }),
    }
  );
  const seData = await seRes.json();

  // Log to Supabase edge function (fire-and-forget)
  fetch(process.env.WEBHOOK_URL + '/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_id,
      amount,
      customer_name: custName,
      customer_email: custEmail,
      status: seRes.ok ? 'success' : 'se_error',
      se_response: seData,
      provider: 'cashfree',
    }),
  }).catch(() => {});

  return res.status(200).json({
    paid: true,
    se_ok: seRes.ok,
    se_response: seData,
    provider: 'cashfree',
  });
}

async function verifyRazorpay(req, res) {
  const { order_id, payment_id, razorpay_order_id, razorpay_signature, name, email, message } = req.body;
  
  // Validate credentials
  const isTestMode = process.env.PRODUCTION_MODE !== 'true';
  const keySecret = (isTestMode && process.env.RAZORPAY_TEST_KEY_SECRET) 
                    ? process.env.RAZORPAY_TEST_KEY_SECRET 
                    : process.env.RAZORPAY_KEY_SECRET;
  
  if (!keySecret) {
    return res.status(500).json({ 
      error: `Razorpay Key Secret not configured for ${isTestMode ? 'TEST' : 'PRODUCTION'} mode` 
    });
  }

  // Verify HMAC signature
  if (!razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing Razorpay signature data' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(razorpay_order_id + '|' + payment_id)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Invalid Razorpay signature' });
  }

  // Fetch order from Razorpay to get verified amount and notes
  const keyId = (isTestMode && process.env.RAZORPAY_TEST_KEY_ID) 
                ? process.env.RAZORPAY_TEST_KEY_ID 
                : process.env.RAZORPAY_KEY_ID;

  const rzpRes = await fetch(`https://api.razorpay.com/v1/orders/${razorpay_order_id}`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'),
    },
  });
  const order = await rzpRes.json();

  if (!rzpRes.ok) {
    return res.status(502).json({ error: 'Razorpay error', detail: order });
  }

  if (order.status !== 'paid') {
    return res.status(200).json({ paid: false, status: order.status });
  }

  // Use verified data from Razorpay (priority over client-sent)
  const amount = order.amount / 100; // Convert from paise
  const custName = order.notes?.name || name || 'Anonymous';
  const custEmail = order.notes?.email || email || 'no@email.no';
  const tipMsg = order.notes?.message || message || 'Thanks for the tip!';

  // Send to StreamElements
  const seRes = await fetch(
    `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SE_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        user: {
          username: custName,
          userId: 'rzp-' + razorpay_order_id,
          email: custEmail,
        },
        provider: 'Razorpay',
        message: tipMsg,
        amount,
        currency: 'INR',
        imported: 'true',
      }),
    }
  );
  const seData = await seRes.json();

  // Log to Supabase edge function (fire-and-forget)
  fetch(process.env.WEBHOOK_URL + '/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_id: razorpay_order_id,
      amount,
      customer_name: custName,
      customer_email: custEmail,
      status: seRes.ok ? 'success' : 'se_error',
      se_response: seData,
      provider: 'razorpay',
    }),
  }).catch(() => {});

  return res.status(200).json({
    paid: true,
    se_ok: seRes.ok,
    se_response: seData,
    provider: 'razorpay',
  });
}

async function verifyPaypal(req, res) {
  const { order_id, payment_id, name, email, message } = req.body;
  
  // Validate credentials
  const isTestMode = process.env.PRODUCTION_MODE !== 'true';
  const clientId = (isTestMode && process.env.PAYPAL_SANDBOX_CLIENT_ID) 
                   ? process.env.PAYPAL_SANDBOX_CLIENT_ID 
                   : process.env.PAYPAL_CLIENT_ID;
  const clientSecret = (isTestMode && process.env.PAYPAL_SANDBOX_CLIENT_SECRET) 
                       ? process.env.PAYPAL_SANDBOX_CLIENT_SECRET 
                       : process.env.PAYPAL_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: `PayPal credentials not configured for ${isTestMode ? 'TEST' : 'PRODUCTION'} mode`
    });
  }

  const paypalBaseUrl = isTestMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  if (!payment_id) {
    return res.status(400).json({ error: 'Missing PayPal payment ID' });
  }

  // Get access token
  const tokenRes = await fetch(paypalBaseUrl + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    return res.status(500).json({ error: 'Failed to get PayPal access token' });
  }

  let payment;
  
  // Try to execute the payment first
  try {
    const executeRes = await fetch(paypalBaseUrl + `/v1/payments/payment/${payment_id}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tokenData.access_token,
      },
      body: JSON.stringify({ payer_id: req.body.payer_id }),
    });

    payment = await executeRes.json();
    
    if (!executeRes.ok && payment.name !== 'INVALID_RESOURCE_ID' && payment.name !== 'PAYMENT_ALREADY_DONE') {
      return res.status(502).json({ error: 'PayPal error', detail: payment });
    }
  } catch (e) {
    // If execute fails, fetch payment details instead
  }

  // If execution failed or wasn't attempted, fetch payment details
  if (!payment || !payment.state) {
    const fetchRes = await fetch(paypalBaseUrl + `/v1/payments/payment/${payment_id}`, {
      headers: {
        'Authorization': 'Bearer ' + tokenData.access_token,
      },
    });
    payment = await fetchRes.json();
  }

  if (payment.state !== 'approved') {
    return res.status(200).json({ paid: false, status: payment.state });
  }

  // Extract custom field data
  let customData = {};
  try {
    customData = JSON.parse(payment.transactions[0]?.custom || '{}');
  } catch (e) {}

  const amount = parseFloat(payment.transactions[0]?.amount?.total) || 0;
  const custName = customData.name || name || 'Anonymous';
  const custEmail = customData.email || email || 'no@email.no';
  const tipMsg = customData.message || message || 'Thanks for the tip!';

  // Send to StreamElements
  const seRes = await fetch(
    `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SE_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        user: {
          username: custName,
          userId: 'pp-' + payment_id,
          email: custEmail,
        },
        provider: 'PayPal',
        message: tipMsg,
        amount,
        currency: 'USD',
        imported: 'true',
      }),
    }
  );
  const seData = await seRes.json();

  // Log to Supabase edge function (fire-and-forget)
  fetch(process.env.WEBHOOK_URL + '/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_id: customData.order_id || order_id,
      amount,
      customer_name: custName,
      customer_email: custEmail,
      status: seRes.ok ? 'success' : 'se_error',
      se_response: seData,
      provider: 'paypal',
    }),
  }).catch(() => {});

  return res.status(200).json({
    paid: true,
    se_ok: seRes.ok,
    se_response: seData,
    provider: 'paypal',
  });
}
