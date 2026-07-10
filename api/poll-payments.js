/**
 * /api/poll-payments.js
 *
 * Vercel Cron Job — runs every 60 seconds.
 * Picks up all 'pending' donations created in the last 5 minutes,
 * checks their status with the payment provider,
 * fires StreamElements on success, and updates Supabase.
 *
 * Secured with CRON_SECRET so only Vercel can call it.
 */

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FIVE_MIN_MS  = 5 * 60 * 1000;

// ─── Supabase helpers ────────────────────────────────────────────────────────

async function sbFetch(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

async function getPendingDonations() {
  const cutoff = new Date(Date.now() - FIVE_MIN_MS).toISOString();
  const { ok, data } = await sbFetch(
    'GET',
    `/donations?status=eq.pending&created_at=gte.${cutoff}&select=*`
  );
  if (!ok) throw new Error('Failed to fetch pending donations: ' + JSON.stringify(data));
  return data || [];
}

async function updateDonation(orderId, fields) {
  await sbFetch(
    'PATCH',
    `/donations?order_id=eq.${orderId}`,
    fields
  );
}

async function markExpired() {
  // Any pending row older than 5 min → failed (payment window closed)
  const cutoff = new Date(Date.now() - FIVE_MIN_MS).toISOString();
  await sbFetch(
    'PATCH',
    `/donations?status=eq.pending&created_at=lt.${cutoff}`,
    { status: 'failed' }
  );
}

// ─── StreamElements ──────────────────────────────────────────────────────────
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
  const seRes = await fetch(
    `https://api.streamelements.com/kappa/v2/tips/${process.env.SE_CHANNEL_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SE_JWT_TOKEN}`,
      },
      body: JSON.stringify({
        user: {
          username: name,
          userId:   `${provider}-${orderId}`,
          email:    email,
        },
        provider: seProviderLabel(provider),
        message:  message || 'Thanks for the tip!',
        amount,
        currency,
        imported: 'true',
      }),
    }
  );
  const seData = await seRes.json();
  return { ok: seRes.ok, data: seData };
}

// ─── Provider status checkers ────────────────────────────────────────────────

const isTestMode = process.env.PRODUCTION_MODE !== 'true';

async function checkCashfree(donation) {
  const appId = isTestMode
    ? (process.env.CASHFREE_SANDBOX_APP_ID    || process.env.CASHFREE_APP_ID)
    : process.env.CASHFREE_APP_ID;
  const secretKey = isTestMode
    ? (process.env.CASHFREE_SANDBOX_SECRET_KEY || process.env.CASHFREE_SECRET_KEY)
    : process.env.CASHFREE_SECRET_KEY;

  if (!appId || !secretKey) throw new Error('Cashfree credentials missing');

  const cfBase = isTestMode ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg';

  const res = await fetch(`${cfBase}/orders/${donation.order_id}`, {
    headers: {
      'x-api-version':   '2023-08-01',
      'x-client-id':     appId,
      'x-client-secret': secretKey,
    },
  });
  const order = await res.json();
  if (!res.ok) throw new Error(`Cashfree fetch error: ${JSON.stringify(order)}`);

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

  // Look up the Razorpay order by receipt (which equals our order_id)
  const res = await fetch(
    `https://api.razorpay.com/v1/orders?receipt=${encodeURIComponent(donation.order_id)}&count=1`,
    {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Razorpay fetch error: ${JSON.stringify(data)}`);

  const order = data.items?.[0];
  if (!order) return { paid: false, status: 'not_found' };
  if (order.status !== 'paid') return { paid: false, status: order.status };

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
  if (!tokenRes.ok || !tokenData.access_token) throw new Error('PayPal token fetch failed');

  const authHeader = { 'Authorization': `Bearer ${tokenData.access_token}` };

  // Fetch the order directly by id — no more scanning recent payments.
  const getRes = await fetch(`${ppBase}/v2/checkout/orders/${donation.provider_order_id}`, { headers: authHeader });
  let order = await getRes.json();
  if (!getRes.ok) throw new Error('PayPal order fetch failed: ' + JSON.stringify(order));

  // Buyer approved on PayPal's site but funds aren't captured yet — capture now.
  if (order.status === 'APPROVED') {
    const captureRes = await fetch(`${ppBase}/v2/checkout/orders/${donation.provider_order_id}/capture`, {
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
  if (!res.ok) throw new Error(`Stripe fetch error: ${JSON.stringify(session)}`);

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

// ─── Process one donation ────────────────────────────────────────────────────

async function processDonation(donation) {
  const { order_id, provider } = donation;
  let result;

  try {
    if (provider === 'razorpay')       result = await checkRazorpay(donation);
    else if (provider === 'paypal')    result = await checkPaypal(donation);
    else if (provider === 'stripe')    result = await checkStripe(donation);
    else                               result = await checkCashfree(donation);
  } catch (err) {
    console.error(`[poll] check error for ${order_id}:`, err.message);
    return; // leave as pending; next cron run will retry within the 5-min window
  }

  if (!result.paid) {
    console.log(`[poll] ${order_id} not paid yet (${result.status})`);
    return;
  }

  // Fire StreamElements
  const se = await fireStreamElements({
    name:     result.name,
    email:    result.email,
    amount:   result.amount,
    currency: result.currency,
    message:  result.message,
    orderId:  order_id,
    provider,
  }).catch(err => ({ ok: false, data: { error: err.message } }));

  console.log(`[poll] ${order_id} PAID — SE fired: ${se.ok}`);

  // Update Supabase row
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
}

// ─── Cron handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Vercel sets Authorization: Bearer <CRON_SECRET> for cron invocations
  const authHeader = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Expire stale pending rows
    await markExpired();

    // 2. Fetch fresh pending rows
    const pending = await getPendingDonations();
    console.log(`[poll] found ${pending.length} pending donation(s)`);

    // 3. Check each one (in parallel, max 5 at once)
    const chunks = [];
    for (let i = 0; i < pending.length; i += 5) chunks.push(pending.slice(i, i + 5));
    for (const chunk of chunks) await Promise.all(chunk.map(processDonation));

    return res.status(200).json({ checked: pending.length, ts: new Date().toISOString() });
  } catch (err) {
    console.error('[poll] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
