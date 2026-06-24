export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { name, email, amount, message, provider } = req.body;
  
  // Validate required fields
  if (!name) {
    return res.status(400).json({ 
      error: 'Name is required',
      field: 'name',
      code: 'MISSING_NAME'
    });
  }
  
  if (!email) {
    return res.status(400).json({ 
      error: 'Email is required',
      field: 'email',
      code: 'MISSING_EMAIL'
    });
  }
  
  // Validate amount as an actual finite number
  const parsedAmount = parseFloat(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ 
      error: 'Invalid amount. Must be a positive number',
      field: 'amount',
      code: 'INVALID_AMOUNT'
    });
  }

  const orderId = 'tip-' + Date.now();
  const origin  = req.headers.origin || req.headers.host;
  const baseUrl = origin.startsWith('http') ? origin : 'https://' + origin;

  // Single source of truth: PRODUCTION_MODE
  const isTestMode = process.env.PRODUCTION_MODE !== 'true';
  
  const modeInfo = {
    mode: isTestMode ? 'TEST' : 'PRODUCTION',
    production_mode: process.env.PRODUCTION_MODE || 'unset'
  };
  
  console.log(`[Payment Request] Mode: ${modeInfo.mode}, Provider: ${provider || 'cashfree'}`, modeInfo);

  // Handle different payment providers
  if (provider === 'razorpay') {
    return handleRazorpay(req, res, { name, email, amount: parsedAmount, message, orderId, baseUrl, modeInfo, isTestMode });
  } else if (provider === 'paypal') {
    return handlePaypal(req, res, { name, email, amount: parsedAmount, message, orderId, baseUrl, modeInfo, isTestMode });
  } else {
    // Default to Cashfree
    return handleCashfree(req, res, { name, email, amount: parsedAmount, message, orderId, baseUrl, modeInfo, isTestMode });
  }
}

async function handleCashfree(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo, isTestMode }) {
  // Validate credentials - check for both production and sandbox credentials
  const hasProductionCredentials = process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY;
  const hasSandboxCredentials = process.env.CASHFREE_SANDBOX_APP_ID && process.env.CASHFREE_SANDBOX_SECRET_KEY;
  
  if (!hasProductionCredentials && !hasSandboxCredentials) {
    return res.status(500).json({
      error: 'Cashfree credentials not configured',
      field: 'CASHFREE_APP_ID or CASHFREE_SANDBOX_APP_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  // Use sandbox credentials in test mode if available, otherwise use production credentials
  const appId = (isTestMode && process.env.CASHFREE_SANDBOX_APP_ID) 
                ? process.env.CASHFREE_SANDBOX_APP_ID 
                : process.env.CASHFREE_APP_ID;
  const secretKey = (isTestMode && process.env.CASHFREE_SANDBOX_SECRET_KEY) 
                    ? process.env.CASHFREE_SANDBOX_SECRET_KEY 
                    : process.env.CASHFREE_SECRET_KEY;
  
  if (!appId) {
    return res.status(500).json({
      error: `Cashfree App ID not configured for ${modeInfo.mode} mode`,
      field: isTestMode ? 'CASHFREE_SANDBOX_APP_ID' : 'CASHFREE_APP_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  if (!secretKey) {
    return res.status(500).json({
      error: `Cashfree Secret Key not configured for ${modeInfo.mode} mode`,
      field: isTestMode ? 'CASHFREE_SANDBOX_SECRET_KEY' : 'CASHFREE_SECRET_KEY',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  try {
    // Determine Cashfree API endpoint based on PRODUCTION_MODE
    const cfBaseUrl = isTestMode ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';
    
    const cfRes = await fetch(cfBaseUrl + '/orders', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-version':   '2023-08-01',
        'x-client-id':     appId,
        'x-client-secret': secretKey,
      },
      body: JSON.stringify({
        order_id:     orderId,
        order_amount: amount,
        order_currency: 'INR',
        customer_details: {
          customer_id:    'cust-' + Date.now(),
          customer_name:  name,
          customer_email: email,
          customer_phone: '9999999999',
        },
        order_meta: {
          notify_url: process.env.WEBHOOK_URL,
          return_url: `${baseUrl}/thankyou?order_id=${orderId}&provider=cashfree`,
        },
        order_tags: {
          message: message || '',
        }
      })
    });

    const order = await cfRes.json();

    if (!cfRes.ok) {
      console.error('[Cashfree Error]', {
        status: cfRes.status,
        response: order,
        mode: modeInfo.mode
      });
      return res.status(500).json({
        error:       'Failed to create Cashfree order',
        cf_status:   cfRes.status,
        cf_response: order,
        mode: modeInfo
      });
    }

    console.log('[Cashfree Success]', {
      order_id: order.order_id,
      payment_session_id: order.payment_session_id ? 'present' : 'missing',
      mode: modeInfo.mode
    });

    // Fire and forget — edge polls CF and logs result
    if (process.env.SUPABASE_FUNCTIONS_URL) {
      fetch(process.env.SUPABASE_FUNCTIONS_URL + '/poll', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret:         process.env.LOG_SECRET,
          order_id:       order.order_id,
          amount,
          customer_name:  name,
          customer_email: email,
          message:        message || '',
        }),
      }).catch(() => {});
    }

    return res.status(200).json({
      order_id:           order.order_id,
      razorpay_order_id:  null,
      paypal_approval_url: null,
      payment_session_id: order.payment_session_id,
      provider: 'cashfree',
      mode: modeInfo
    });

  } catch (err) {
    return res.status(500).json({ 
      error: 'Server error creating Cashfree order', 
      details: err.message,
      mode: modeInfo
    });
  }
}

async function handleRazorpay(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo, isTestMode }) {
  // Validate credentials - check for both production and test credentials
  const hasProductionCredentials = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET;
  const hasTestCredentials = process.env.RAZORPAY_TEST_KEY_ID && process.env.RAZORPAY_TEST_KEY_SECRET;
  
  if (!hasProductionCredentials && !hasTestCredentials) {
    return res.status(500).json({
      error: 'Razorpay credentials not configured',
      field: 'RAZORPAY_KEY_ID or RAZORPAY_TEST_KEY_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  // Use test credentials in test mode if available, otherwise use production credentials
  const keyId = (isTestMode && process.env.RAZORPAY_TEST_KEY_ID) 
                ? process.env.RAZORPAY_TEST_KEY_ID 
                : process.env.RAZORPAY_KEY_ID;
  const keySecret = (isTestMode && process.env.RAZORPAY_TEST_KEY_SECRET) 
                    ? process.env.RAZORPAY_TEST_KEY_SECRET 
                    : process.env.RAZORPAY_KEY_SECRET;
  
  if (!keyId) {
    return res.status(500).json({
      error: `Razorpay Key ID not configured for ${modeInfo.mode} mode`,
      field: isTestMode ? 'RAZORPAY_TEST_KEY_ID' : 'RAZORPAY_KEY_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  if (!keySecret) {
    return res.status(500).json({
      error: `Razorpay Key Secret not configured for ${modeInfo.mode} mode`,
      field: isTestMode ? 'RAZORPAY_TEST_KEY_SECRET' : 'RAZORPAY_KEY_SECRET',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  try {
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'),
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100),
        currency: 'INR',
        receipt: orderId,
        notes: {
          name: name,
          email: email,
          message: message || '',
        }
      })
    });

    const order = await rzpRes.json();

    if (!rzpRes.ok) {
      return res.status(500).json({
        error: 'Failed to create Razorpay order',
        rzp_response: order,
        mode: modeInfo
      });
    }

    // Fire and forget donation log webhook (same as Cashfree)
    if (process.env.SUPABASE_FUNCTIONS_URL) {
      fetch(process.env.SUPABASE_FUNCTIONS_URL + '/poll', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret:         process.env.LOG_SECRET,
          order_id:       order.id,
          amount,
          customer_name:  name,
          customer_email: email,
          message:        message || '',
          provider:       'razorpay',
        }),
      }).catch(() => {});
    }

    return res.status(200).json({
      order_id: orderId,
      razorpay_order_id: order.id,
      razorpay_key_id: keyId,
      paypal_approval_url: null,
      provider: 'razorpay',
      mode: modeInfo
    });

  } catch (err) {
    return res.status(500).json({ 
      error: 'Server error creating Razorpay order', 
      details: err.message,
      mode: modeInfo
    });
  }
}

async function handlePaypal(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo, isTestMode }) {
  // Validate credentials - check for both production and sandbox credentials
  const hasProductionCredentials = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET;
  const hasSandboxCredentials = process.env.PAYPAL_SANDBOX_CLIENT_ID && process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  
  if (!hasProductionCredentials && !hasSandboxCredentials) {
    return res.status(500).json({
      error: 'PayPal credentials not configured',
      field: 'PAYPAL_CLIENT_ID or PAYPAL_SANDBOX_CLIENT_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  // Use sandbox credentials in test mode if available, otherwise use production credentials
  const clientId = (isTestMode && process.env.PAYPAL_SANDBOX_CLIENT_ID) 
                   ? process.env.PAYPAL_SANDBOX_CLIENT_ID 
                   : process.env.PAYPAL_CLIENT_ID;
  const clientSecret = (isTestMode && process.env.PAYPAL_SANDBOX_CLIENT_SECRET) 
                       ? process.env.PAYPAL_SANDBOX_CLIENT_SECRET 
                       : process.env.PAYPAL_CLIENT_SECRET;
  
  // Switch API endpoint based on mode
  const paypalBaseUrl = isTestMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  
  if (!clientId) {
    return res.status(500).json({
      error: `PayPal Client ID not configured for ${modeInfo.mode} mode`,
      field: isTestMode ? 'PAYPAL_SANDBOX_CLIENT_ID' : 'PAYPAL_CLIENT_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  if (!clientSecret) {
    return res.status(500).json({
      error: `PayPal Client Secret not configured for ${modeInfo.mode} mode`,
      field: isTestMode ? 'PAYPAL_SANDBOX_CLIENT_SECRET' : 'PAYPAL_CLIENT_SECRET',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  try {
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
      return res.status(500).json({ 
        error: 'Failed to get PayPal access token',
        mode: modeInfo
      });
    }

    // Create payment - store name/email/message in custom field
    const paymentRes = await fetch(paypalBaseUrl + '/v1/payments/payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tokenData.access_token,
      },
      body: JSON.stringify({
        intent: 'sale',
        payer: {
          payment_method: 'paypal',
        },
        transactions: [{
          amount: {
            total: amount.toString(),
            currency: 'USD',
          },
          description: 'Tip for streamer',
          custom: JSON.stringify({
            name: name,
            email: email,
            message: message || '',
            order_id: orderId,
          }),
          item_list: {
            items: [{
              name: 'Tip',
              price: amount.toString(),
              currency: 'USD',
              quantity: 1,
            }],
          },
        }],
        redirect_urls: {
          return_url: `${baseUrl}/thankyou?order_id=${orderId}&provider=paypal`,
          cancel_url: `${baseUrl}/`,
        },
      }),
    });

    const payment = await paymentRes.json();
    if (!paymentRes.ok || !payment.links) {
      return res.status(500).json({ 
        error: 'Failed to create PayPal payment',
        mode: modeInfo
      });
    }

    const approvalUrl = payment.links.find(link => link.rel === 'approval_url')?.href;
    if (!approvalUrl) {
      return res.status(500).json({ 
        error: 'No approval URL from PayPal',
        mode: modeInfo
      });
    }

    return res.status(200).json({
      order_id: orderId,
      paypal_approval_url: approvalUrl,
      razorpay_order_id: null,
      provider: 'paypal',
      mode: modeInfo
    });

  } catch (err) {
    return res.status(500).json({ 
      error: 'Server error creating PayPal payment', 
      details: err.message,
      mode: modeInfo
    });
  }
}
