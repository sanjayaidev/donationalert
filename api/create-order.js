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
  
  if (!amount || amount < 1) {
    return res.status(400).json({ 
      error: 'Invalid amount. Minimum amount is 1',
      field: 'amount',
      code: 'INVALID_AMOUNT'
    });
  }

  const orderId = 'tip-' + Date.now();
  const origin  = req.headers.origin || req.headers.host;
  const baseUrl = origin.startsWith('http') ? origin : 'https://' + origin;

  // Detect environment mode
  const isTestMode = process.env.NODE_ENV === 'test' || 
                     process.env.VERCEL_ENV === 'preview' ||
                     !process.env.PRODUCTION_MODE;
  
  const modeInfo = {
    mode: isTestMode ? 'TEST' : 'PRODUCTION',
    node_env: process.env.NODE_ENV || 'development',
    vercel_env: process.env.VERCEL_ENV || 'not-set'
  };
  
  console.log(`[Payment Request] Mode: ${modeInfo.mode}, Provider: ${provider || 'cashfree'}`);

  // Handle different payment providers
  if (provider === 'razorpay') {
    return handleRazorpay(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo });
  } else if (provider === 'paypal') {
    return handlePaypal(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo });
  } else {
    // Default to Cashfree
    return handleCashfree(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo });
  }
}

async function handleCashfree(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo }) {
  // Validate credentials
  if (!process.env.CASHFREE_APP_ID) {
    return res.status(500).json({
      error: 'Cashfree App ID not configured',
      field: 'CASHFREE_APP_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  if (!process.env.CASHFREE_SECRET_KEY) {
    return res.status(500).json({
      error: 'Cashfree Secret Key not configured',
      field: 'CASHFREE_SECRET_KEY',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  try {
    const cfRes = await fetch('https://api.cashfree.com/pg/orders', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-version':   '2023-08-01',
        'x-client-id':     process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
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
          return_url: `${baseUrl}/thankyou?order_id=${orderId}`,
        },
        order_tags: {
          message: message || '',
        }
      })
    });

    const order = await cfRes.json();

    if (!cfRes.ok) {
      return res.status(500).json({
        error:       'Failed to create Cashfree order',
        cf_status:   cfRes.status,
        cf_response: order,
        mode: modeInfo
      });
    }

    // Fire and forget — edge polls CF and logs result
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

    return res.status(200).json({
      order_id:           order.order_id,
      payment_session_id: order.payment_session_id,
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

async function handleRazorpay(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo }) {
  // Validate credentials
  if (!process.env.RAZORPAY_KEY_ID) {
    return res.status(500).json({
      error: 'Razorpay Key ID not configured',
      field: 'RAZORPAY_KEY_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.status(500).json({
      error: 'Razorpay Key Secret not configured',
      field: 'RAZORPAY_KEY_SECRET',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  try {
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64'),
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

    return res.status(200).json({
      order_id: orderId,
      razorpay_order_id: order.id,
      razorpay_key_id: process.env.RAZORPAY_KEY_ID,
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

async function handlePaypal(req, res, { name, email, amount, message, orderId, baseUrl, modeInfo }) {
  // Validate credentials
  if (!process.env.PAYPAL_CLIENT_ID) {
    return res.status(500).json({
      error: 'PayPal Client ID not configured',
      field: 'PAYPAL_CLIENT_ID',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  if (!process.env.PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({
      error: 'PayPal Client Secret not configured',
      field: 'PAYPAL_CLIENT_SECRET',
      code: 'MISSING_CREDENTIAL',
      mode: modeInfo
    });
  }
  
  try {
    // Get access token
    const tokenRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET).toString('base64'),
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

    // Create payment
    const paymentRes = await fetch('https://api-m.paypal.com/v1/payments/payment', {
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
          return_url: `${baseUrl}/thankyou?order_id=${orderId}`,
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
