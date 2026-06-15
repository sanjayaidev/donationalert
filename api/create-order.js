export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, email, amount, message, provider } = req.body;

  if (!name || !email || !amount || amount < 1) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const orderId = 'tip-' + Date.now();
  const origin  = req.headers.origin || req.headers.host;
  const baseUrl = origin.startsWith('http') ? origin : 'https://' + origin;

  // Handle different payment providers
  if (provider === 'razorpay') {
    return handleRazorpay(req, res, { name, email, amount, message, orderId, baseUrl });
  } else if (provider === 'paypal') {
    return handlePaypal(req, res, { name, email, amount, message, orderId, baseUrl });
  } else {
    // Default to Cashfree
    return handleCashfree(req, res, { name, email, amount, message, orderId, baseUrl });
  }
}

async function handleCashfree(req, res, { name, email, amount, message, orderId, baseUrl }) {
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
        error:       'Failed to create order',
        cf_status:   cfRes.status,
        cf_response: order
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
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
}

async function handleRazorpay(req, res, { name, email, amount, message, orderId, baseUrl }) {
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
        rzp_response: order
      });
    }

    return res.status(200).json({
      order_id: orderId,
      razorpay_order_id: order.id,
      razorpay_key_id: process.env.RAZORPAY_KEY_ID,
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
}

async function handlePaypal(req, res, { name, email, amount, message, orderId, baseUrl }) {
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
      return res.status(500).json({ error: 'Failed to get PayPal access token' });
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
      return res.status(500).json({ error: 'Failed to create PayPal payment' });
    }

    const approvalUrl = payment.links.find(link => link.rel === 'approval_url')?.href;
    if (!approvalUrl) {
      return res.status(500).json({ error: 'No approval URL from PayPal' });
    }

    return res.status(200).json({
      order_id: orderId,
      paypal_approval_url: approvalUrl,
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
}
