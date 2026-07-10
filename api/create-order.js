import crypto from 'crypto';

// ─── Supabase helper ────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  }
  return res;
}

async function insertPending({ order_id, provider, amount, currency = 'INR', name, email, message, provider_order_id }) {
  await supabase('POST', '/donations', {
    order_id,
    provider,
    status:         'pending',
    amount,
    currency,
    customer_name:  name,
    customer_email: email,
    message:        message || '',
    ...(provider_order_id ? { provider_order_id } : {}),
  });
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, email, amount, message, provider } = req.body;

  if (!name)  return res.status(400).json({ error: 'Name is required',  code: 'MISSING_NAME' });
  if (!email) return res.status(400).json({ error: 'Email is required', code: 'MISSING_EMAIL' });

  const parsedAmount = parseFloat(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
    return res.status(400).json({ error: 'Amount must be ≥ 1', code: 'INVALID_AMOUNT' });
  }

  // Use a short hex suffix so the ID stays alphanumeric (Cashfree requirement)
  const orderId  = 'tip' + Date.now() + crypto.randomBytes(3).toString('hex');
  const origin   = req.headers.origin || req.headers.host || '';
  const baseUrl  = origin.startsWith('http') ? origin : `https://${origin}`;
  const isTestMode = process.env.PRODUCTION_MODE !== 'true';
  const modeInfo = { mode: isTestMode ? 'TEST' : 'PRODUCTION' };

  console.log(`[create-order] provider=${provider || 'cashfree'} amount=${parsedAmount} mode=${modeInfo.mode}`);

  if (provider === 'razorpay') {
    return handleRazorpay(res, { name, email, amount: parsedAmount, message, orderId, baseUrl, modeInfo, isTestMode });
  } else if (provider === 'paypal') {
    return handlePaypal(res, { name, email, amount: parsedAmount, message, orderId, baseUrl, modeInfo, isTestMode });
  } else if (provider === 'stripe') {
    return handleStripe(res, { name, email, amount: parsedAmount, message, orderId, baseUrl, modeInfo, isTestMode });
  } else {
    return handleCashfree(res, { name, email, amount: parsedAmount, message, orderId, baseUrl, modeInfo, isTestMode });
  }
}

// ─── Cashfree ────────────────────────────────────────────────────────────────
async function handleCashfree(res, { name, email, amount, message, orderId, baseUrl, modeInfo, isTestMode }) {
  const appId = isTestMode
    ? (process.env.CASHFREE_SANDBOX_APP_ID    || process.env.CASHFREE_APP_ID)
    : process.env.CASHFREE_APP_ID;
  const secretKey = isTestMode
    ? (process.env.CASHFREE_SANDBOX_SECRET_KEY || process.env.CASHFREE_SECRET_KEY)
    : process.env.CASHFREE_SECRET_KEY;

  if (!appId || !secretKey) {
    return res.status(500).json({
      error: `Cashfree credentials not set for ${modeInfo.mode} mode`,
      code:  'MISSING_CREDENTIAL',
    });
  }

  const cfBaseUrl = isTestMode
    ? 'https://sandbox.cashfree.com/pg'
    : 'https://api.cashfree.com/pg';

  try {
    const cfRes = await fetch(`${cfBaseUrl}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-version':   '2023-08-01',
        'x-client-id':     appId,
        'x-client-secret': secretKey,
      },
      body: JSON.stringify({
        order_id:       orderId,
        order_amount:   parseFloat(amount.toFixed(2)),   // max 2 decimals
        order_currency: 'INR',
        customer_details: {
          customer_id:    'cust' + Date.now(),
          customer_name:  name,
          customer_email: email,
          customer_phone: '9999999999',                  // required by CF; donor may not have one
        },
        order_meta: {
          // {order_id} placeholder is REQUIRED by Cashfree — it replaces it on redirect
          return_url: `${baseUrl}/thankyou?order_id={order_id}&provider=cashfree`,
        },
        order_tags: { message: message || '' },
      }),
    });

    const order = await cfRes.json();

    if (!cfRes.ok) {
      console.error('[Cashfree] create-order error', { status: cfRes.status, order });
      return res.status(502).json({
        error:       'Cashfree order creation failed',
        cf_status:   cfRes.status,
        cf_response: order,
        mode:        modeInfo,
      });
    }

    if (!order.payment_session_id) {
      return res.status(502).json({
        error:    'No payment_session_id from Cashfree',
        cf_order: order,
        mode:     modeInfo,
      });
    }

    // Persist pending row — poller will handle verification
    await insertPending({ order_id: orderId, provider: 'cashfree', amount, name, email, message });

    return res.status(200).json({
      order_id:           orderId,
      payment_session_id: order.payment_session_id,
      provider:           'cashfree',
      mode:               modeInfo,
    });

  } catch (err) {
    console.error('[Cashfree] exception', err);
    return res.status(500).json({ error: err.message, mode: modeInfo });
  }
}

// ─── Razorpay ────────────────────────────────────────────────────────────────
async function handleRazorpay(res, { name, email, amount, message, orderId, baseUrl, modeInfo, isTestMode }) {
  const keyId = isTestMode
    ? (process.env.RAZORPAY_TEST_KEY_ID     || process.env.RAZORPAY_KEY_ID)
    : process.env.RAZORPAY_KEY_ID;
  const keySecret = isTestMode
    ? (process.env.RAZORPAY_TEST_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET)
    : process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return res.status(500).json({ error: `Razorpay credentials not set for ${modeInfo.mode} mode`, code: 'MISSING_CREDENTIAL' });
  }

  try {
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: JSON.stringify({
        amount:   Math.round(amount * 100),   // paise
        currency: 'INR',
        receipt:  orderId,
        notes:    { name, email, message: message || '' },
      }),
    });

    const order = await rzpRes.json();

    if (!rzpRes.ok) {
      return res.status(502).json({ error: 'Razorpay order creation failed', rzp_response: order, mode: modeInfo });
    }

    await insertPending({ order_id: orderId, provider: 'razorpay', amount, name, email, message });

    return res.status(200).json({
      order_id:          orderId,
      razorpay_order_id: order.id,
      razorpay_key_id:   keyId,
      provider:          'razorpay',
      mode:              modeInfo,
    });

  } catch (err) {
    console.error('[Razorpay] exception', err);
    return res.status(500).json({ error: err.message, mode: modeInfo });
  }
}

// ─── PayPal ──────────────────────────────────────────────────────────────────
// NOTE: Migrated from the legacy v1 Payments API to the v2 Orders API.
// The old v1 flow created a payment in 'created' state and required a
// separate POST /v1/payments/payment/{id}/execute call (using the PayerID
// PayPal appends to return_url) to actually capture funds. That execute
// call was missing everywhere in this codebase, so payments never left
// 'created' state and could never be verified as paid. The v2 Orders API
// collapses this into a single 'capture' call keyed off a real order id,
// which also removes the old "scan the last 5-10 payments" lookup hack.
async function handlePaypal(res, { name, email, amount, message, orderId, baseUrl, modeInfo, isTestMode }) {
  const clientId = isTestMode
    ? (process.env.PAYPAL_SANDBOX_CLIENT_ID     || process.env.PAYPAL_CLIENT_ID)
    : process.env.PAYPAL_CLIENT_ID;
  const clientSecret = isTestMode
    ? (process.env.PAYPAL_SANDBOX_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET)
    : process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: `PayPal credentials not set for ${modeInfo.mode} mode`, code: 'MISSING_CREDENTIAL' });
  }

  const ppBase = isTestMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  try {
    // Get access token
    const tokenRes = await fetch(`${ppBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.status(500).json({ error: 'PayPal token fetch failed', mode: modeInfo });
    }

    // Create order (v2 API). reference_id/custom_id carry our own orderId
    // so verify-order/poll-payments can match this back to the Supabase row.
    const ppRes = await fetch(`${ppBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${tokenData.access_token}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: orderId,
          custom_id:    orderId,
          description:  'Tip for streamer',
          amount: {
            currency_code: 'USD',
            value:         amount.toFixed(2),
          },
        }],
        application_context: {
          return_url:          `${baseUrl}/thankyou?order_id=${orderId}&provider=paypal`,
          cancel_url:          `${baseUrl}/`,
          user_action:         'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      }),
    });

    const order = await ppRes.json();
    const approvalUrl = order.links?.find(l => l.rel === 'approve')?.href;

    if (!ppRes.ok || !approvalUrl) {
      console.error('[PayPal] create-order error', { status: ppRes.status, order });
      return res.status(502).json({ error: 'PayPal order creation failed', pp_response: order, mode: modeInfo });
    }

    // Store PayPal's own order id now (not just at capture time) so
    // verify-order/poll-payments can fetch this exact order directly
    // instead of searching recent payments.
    await insertPending({
      order_id: orderId,
      provider: 'paypal',
      amount,
      currency: 'USD',
      name, email, message,
      provider_order_id: order.id,
    });

    return res.status(200).json({
      order_id:            orderId,
      paypal_approval_url: approvalUrl,
      provider:            'paypal',
      mode:                modeInfo,
    });

  } catch (err) {
    console.error('[PayPal] exception', err);
    return res.status(500).json({ error: err.message, mode: modeInfo });
  }
}

// ─── Stripe ──────────────────────────────────────────────────────────────────
// Uses a hosted Checkout Session (redirect flow), the same shape as the
// PayPal approval-url flow above. Stripe's REST API only accepts
// application/x-www-form-urlencoded bodies (with bracket notation for
// nested/array fields) — it does not accept JSON — so we build the body
// with URLSearchParams instead of JSON.stringify.
async function handleStripe(res, { name, email, amount, message, orderId, baseUrl, modeInfo, isTestMode }) {
  const secretKey = isTestMode
    ? (process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY)
    : process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return res.status(500).json({ error: `Stripe credentials not set for ${modeInfo.mode} mode`, code: 'MISSING_CREDENTIAL' });
  }

  // Stripe Checkout is a global gateway — default to USD like the PayPal
  // flow. Override with STRIPE_CURRENCY if you have an account that
  // supports settling in another currency (e.g. inr).
  const currency = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();

  const body = new URLSearchParams();
  body.append('mode', 'payment');
  body.append('success_url', `${baseUrl}/thankyou?order_id=${orderId}&provider=stripe&session_id={CHECKOUT_SESSION_ID}`);
  body.append('cancel_url', `${baseUrl}/`);
  body.append('client_reference_id', orderId);
  body.append('customer_email', email);
  body.append('metadata[order_id]', orderId);
  body.append('metadata[name]', name);
  body.append('metadata[message]', message || '');
  body.append('line_items[0][quantity]', '1');
  body.append('line_items[0][price_data][currency]', currency);
  body.append('line_items[0][price_data][unit_amount]', String(Math.round(amount * 100))); // smallest currency unit
  body.append('line_items[0][price_data][product_data][name]', 'Tip for streamer');
  if (message) body.append('line_items[0][price_data][product_data][description]', message.slice(0, 250));

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${secretKey}`,
      },
      body: body.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok || !session.url) {
      console.error('[Stripe] create-session error', { status: stripeRes.status, session });
      return res.status(502).json({
        error:           'Stripe checkout session creation failed',
        stripe_response: session,
        mode:            modeInfo,
      });
    }

    // Store Stripe's own session id now so verify-order/poll-payments can
    // fetch this exact session directly, same pattern as PayPal's order id.
    await insertPending({
      order_id: orderId,
      provider: 'stripe',
      amount,
      currency: currency.toUpperCase(),
      name, email, message,
      provider_order_id: session.id,
    });

    return res.status(200).json({
      order_id:              orderId,
      stripe_checkout_url:   session.url,
      stripe_session_id:     session.id,
      provider:              'stripe',
      mode:                  modeInfo,
    });

  } catch (err) {
    console.error('[Stripe] exception', err);
    return res.status(500).json({ error: err.message, mode: modeInfo });
  }
}