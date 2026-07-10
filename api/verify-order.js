/**
 * /api/verify-order.js
 *
 * Called by thankyou.html every 3s.
 * Checks payment status directly with the provider,
 * fires StreamElements + YouTube chat on first success, saves to Supabase.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const isTestMode   = process.env.PRODUCTION_MODE !== 'true';

// Supabase youtube edge function URL
const YT_EDGE_URL  = `${SUPABASE_URL}/functions/v1/youtube`;

// ---- Supabase helpers -------------------------------------------------------

async function getDonation(order_id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/donations?order_id=eq.${encodeURIComponent(order_id)}&select=*&limit=1`,
    {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const rows = await res.json();
  if (!res.ok || !Array.isArray(rows)) throw new Error('Supabase read failed: ' + JSON.stringify(rows));
  return rows[0] || null;
}

async function updateDonation(order_id, fields) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/donations?order_id=eq.${encodeURIComponent(order_id)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(fields),
    }
  );
}

// ---- StreamElements ---------------------------------------------------------
// NOTE: StreamElements' /tips endpoint treats certain provider strings
// (e.g. "Paypal", "Stripe") as reserved keywords tied to its own native
// integrations, and rejects them with a generic "provider contains an
// invalid value" error unless that integration is actually connected on
// the channel. Custom/unrecognized labels (e.g. "Cashfree", "Razorpay")
// are accepted freely as import labels. To avoid the collision, map the
// reserved ones to distinct custom labels before sending.
const SE_PROVIDER_LABELS = {
  cashfree: 'Cashfree',
  razorpay: 'Razorpay',
  paypal:   'PayPal Tip',
  stripe:   'Stripe Tip',
};
function seProviderLabel(provider) {
  return SE_PROVIDER_LABELS[provider] || (provider.charAt(0).toUpperCase() + provider.slice(1));
}

async function fireStreamElements({ name, email, amount, currency, message, orderId, provider }) {
  const res = await fetch(
    `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.SE_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        user: {
          username: name,
          userId:   `${provider}-${orderId}`,
          email,
        },
        provider: seProviderLabel(provider),
        message:  message || 'Thanks for the tip!',
        amount,
        currency,
        imported: 'true',
      }),
    }
  );
  const data = await res.json();
  return { ok: res.ok, data };
}

// ---- YouTube Live Chat ------------------------------------------------------
// Fire-and-forget: silently skipped if streamer is not using the CG Live app
// or has no active broadcast. Requires STREAMER_DEVICE_UID env var.

async function postYouTubeChat({ name, amount, currency, message }) {
  const device_uid = process.env.STREAMER_DEVICE_UID;
  if (!device_uid) throw new Error('STREAMER_DEVICE_UID not set');

  // Step 1: get broadcast_id from auth_sessions
  const authRes = await fetch(
    `${SUPABASE_URL}/rest/v1/auth_sessions?device_uid=eq.${encodeURIComponent(device_uid)}&platform=eq.youtube&slot=eq.default&select=broadcast_id&limit=1`,
    {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  const authRows = await authRes.json();
  const broadcast_id = authRows?.[0]?.broadcast_id;
  if (!broadcast_id) throw new Error('No active broadcast_id found for streamer');

  // Step 2: get live_chat_id from YouTube edge function
  const detailsRes  = await fetch(YT_EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      action:       'get_broadcast_details',
      device_uid,
      broadcast_id,
    }),
  });
  const detailsData = await detailsRes.json();
  const live_chat_id = detailsData?.broadcast?.liveStreamingDetails?.activeLiveChatId;
  if (!live_chat_id) throw new Error('No live_chat_id found for broadcast');

  // Step 3: format and send the message
  const symbol       = currency === 'USD' ? '$' : '\u20b9';
  const chatMessage  = `${name} tipped ${symbol}${amount}${message ? ` -- ${message}` : ''}`;

  const sendRes = await fetch(YT_EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      action:       'send_live_chat_message',
      device_uid,
      live_chat_id,
      message_text: chatMessage,
    }),
  });
  const sendData = await sendRes.json();
  if (!sendData.success) throw new Error('YT chat send failed: ' + JSON.stringify(sendData));
  console.log('[verify] YT chat sent:', chatMessage);
}

// ---- Provider status checkers -----------------------------------------------

async function checkCashfree(donation) {
  const appId = isTestMode
    ? (process.env.CASHFREE_SANDBOX_APP_ID    || process.env.CASHFREE_APP_ID)
    : process.env.CASHFREE_APP_ID;
  const secretKey = isTestMode
    ? (process.env.CASHFREE_SANDBOX_SECRET_KEY || process.env.CASHFREE_SECRET_KEY)
    : process.env.CASHFREE_SECRET_KEY;

  if (!appId || !secretKey) throw new Error('Cashfree credentials missing');

  const cfBase = isTestMode
    ? 'https://sandbox.cashfree.com/pg'
    : 'https://api.cashfree.com/pg';

  const res   = await fetch(`${cfBase}/orders/${donation.order_id}`, {
    headers: {
      'x-api-version':   '2023-08-01',
      'x-client-id':     appId,
      'x-client-secret': secretKey,
    },
  });
  const order = await res.json();
  if (!res.ok) throw new Error('Cashfree fetch error: ' + JSON.stringify(order));

  if (order.order_status !== 'PAID') return { paid: false, status: order.order_status };

  return {
    paid:     true,
    amount:   order.order_amount,
    currency: order.order_currency || 'INR',
    name:     order.customer_details?.customer_name  || donation.customer_name,
    email:    order.customer_details?.customer_email || donation.customer_email,
    message:  order.order_tags?.message              || donation.message,
    provider_order_id: String(order.cf_order_id || ''),
  };
}

async function checkRazorpay(donation) {
  const keyId = isTestMode
    ? (process.env.RAZORPAY_TEST_KEY_ID     || process.env.RAZORPAY_KEY_ID)
    : process.env.RAZORPAY_KEY_ID;
  const keySecret = isTestMode
    ? (process.env.RAZORPAY_TEST_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET)
    : process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) throw new Error('Razorpay credentials missing');

  const res  = await fetch(
    `https://api.razorpay.com/v1/orders?receipt=${encodeURIComponent(donation.order_id)}&count=1`,
    {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
    }
  );
  const data  = await res.json();
  if (!res.ok) throw new Error('Razorpay fetch error: ' + JSON.stringify(data));

  const order = data.items?.[0];
  if (!order || order.status !== 'paid') return { paid: false, status: order?.status || 'not_found' };

  return {
    paid:     true,
    amount:   order.amount / 100,
    currency: order.currency || 'INR',
    name:     order.notes?.name    || donation.customer_name,
    email:    order.notes?.email   || donation.customer_email,
    message:  order.notes?.message || donation.message,
    provider_order_id: order.id,
  };
}

async function checkPaypal(donation) {
  const clientId = isTestMode
    ? (process.env.PAYPAL_SANDBOX_CLIENT_ID     || process.env.PAYPAL_CLIENT_ID)
    : process.env.PAYPAL_CLIENT_ID;
  const clientSecret = isTestMode
    ? (process.env.PAYPAL_SANDBOX_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET)
    : process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) throw new Error('PayPal credentials missing');
  if (!donation.provider_order_id) throw new Error('No PayPal order id stored for this donation');

  const ppBase = isTestMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  const tokenRes  = await fetch(`${ppBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) throw new Error('PayPal token fetch failed');

  const authHeader = { 'Authorization': `Bearer ${tokenData.access_token}` };

  // Fetch the order directly by id — no more scanning recent payments.
  const getRes  = await fetch(`${ppBase}/v2/checkout/orders/${donation.provider_order_id}`, { headers: authHeader });
  let order = await getRes.json();
  if (!getRes.ok) throw new Error('PayPal order fetch failed: ' + JSON.stringify(order));

  // Buyer approved on PayPal's site but funds aren't captured yet — capture now.
  if (order.status === 'APPROVED') {
    const captureRes  = await fetch(`${ppBase}/v2/checkout/orders/${donation.provider_order_id}/capture`, {
      method:  'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
    });
    const captureData = await captureRes.json();
    if (!captureRes.ok) throw new Error('PayPal capture failed: ' + JSON.stringify(captureData));
    order = captureData;
  }

  if (order.status !== 'COMPLETED') {
    return { paid: false, status: order.status || 'not_found' };
  }

  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];

  return {
    paid:     true,
    amount:   parseFloat(capture?.amount?.value || unit?.amount?.value || 0),
    currency: capture?.amount?.currency_code || unit?.amount?.currency_code || 'USD',
    name:     donation.customer_name,
    email:    donation.customer_email,
    message:  donation.message,
    provider_order_id: order.id,
  };
}

async function checkStripe(donation) {
  const secretKey = isTestMode
    ? (process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY)
    : process.env.STRIPE_SECRET_KEY;

  if (!secretKey) throw new Error('Stripe credentials missing');
  if (!donation.provider_order_id) throw new Error('No Stripe session id stored for this donation');

  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${donation.provider_order_id}`,
    { headers: { 'Authorization': `Bearer ${secretKey}` } }
  );
  const session = await res.json();
  if (!res.ok) throw new Error('Stripe fetch error: ' + JSON.stringify(session));

  // payment_status is 'paid' | 'unpaid' | 'no_payment_required'
  if (session.payment_status !== 'paid') {
    return { paid: false, status: session.payment_status || session.status || 'not_found' };
  }

  return {
    paid:     true,
    amount:   (session.amount_total || 0) / 100,
    currency: (session.currency || 'usd').toUpperCase(),
    name:     session.customer_details?.name  || donation.customer_name,
    email:    session.customer_details?.email || donation.customer_email,
    message:  session.metadata?.message       || donation.message,
    provider_order_id: session.id,
  };
}

// ---- Main handler -----------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  try {
    // 1. Get donation row from Supabase
    const donation = await getDonation(order_id);
    if (!donation) return res.status(404).json({ error: 'Order not found' });

    // 2. Already paid - return immediately (idempotent)
    if (donation.status === 'paid') {
      return res.status(200).json({
        paid:     true,
        status:   'paid',
        provider: donation.provider,
        amount:   donation.amount,
        currency: donation.currency,
        se_fired: donation.se_fired,
      });
    }

    // 3. Already failed/expired
    if (donation.status === 'failed') {
      return res.status(200).json({ paid: false, status: 'failed' });
    }

    // 4. Still pending - check with provider
    let result;
    try {
      if (donation.provider === 'razorpay')    result = await checkRazorpay(donation);
      else if (donation.provider === 'paypal') result = await checkPaypal(donation);
      else if (donation.provider === 'stripe') result = await checkStripe(donation);
      else                                     result = await checkCashfree(donation);
    } catch (err) {
      console.error(`[verify] provider check error (${donation.provider}):`, err.message);
      return res.status(200).json({ paid: false, status: 'pending', error: err.message });
    }

    if (!result.paid) {
      return res.status(200).json({ paid: false, status: result.status || 'pending' });
    }

    // 5. Payment confirmed - fire StreamElements
    const se = await fireStreamElements({
      name:     result.name,
      email:    result.email,
      amount:   result.amount,
      currency: result.currency,
      message:  result.message,
      orderId:  order_id,
      provider: donation.provider,
    }).catch(err => ({ ok: false, data: { error: err.message } }));

    console.log(`[verify] ${order_id} PAID - SE fired: ${se.ok}`);

    // 5b. Post to YouTube Live chat (fire-and-forget)
    // Silently skipped if streamer is not using CG Live app or has no active broadcast
    postYouTubeChat({
      name:     result.name,
      amount:   result.amount,
      currency: result.currency,
      message:  result.message,
    }).catch(err => console.log('[verify] YT chat skipped:', err.message));

    // 6. Update Supabase row to paid
    await updateDonation(order_id, {
      status:            'paid',
      provider_order_id: result.provider_order_id || null,
      amount:            result.amount,
      currency:          result.currency,
      customer_name:     result.name,
      customer_email:    result.email,
      se_fired:          se.ok,
      se_response:       se.data,
    });

    return res.status(200).json({
      paid:     true,
      status:   'paid',
      provider: donation.provider,
      amount:   result.amount,
      currency: result.currency,
      se_fired: se.ok,
    });

  } catch (err) {
    console.error('[verify]', err);
    return res.status(500).json({ error: err.message });
  }
}
