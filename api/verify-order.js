/**
 * /api/verify-order.js
 *
 * Called by thankyou.html every 3s.
 * Checks payment status directly with the provider,
 * fires StreamElements on first success, saves to Supabase.
 */

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const isTestMode   = process.env.PRODUCTION_MODE !== 'true';

// ─── Supabase helpers ────────────────────────────────────────────────────────

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

// ─── StreamElements ──────────────────────────────────────────────────────────

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
        provider: provider.charAt(0).toUpperCase() + provider.slice(1),
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

// ─── Provider status checkers ────────────────────────────────────────────────

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

  const ppBase = isTestMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  // Get access token
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

  // Search recent payments and match by custom field
  const searchRes  = await fetch(
    `${ppBase}/v1/payments/payment?count=10&sort_by=create_time&sort_order=descending`,
    { headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
  );
  const searchData = await searchRes.json();

  const payment = searchData.payments?.find(p => {
    try {
      return JSON.parse(p.transactions?.[0]?.custom || '{}').order_id === donation.order_id;
    } catch { return false; }
  });

  if (!payment || payment.state !== 'approved') {
    return { paid: false, status: payment?.state || 'not_found' };
  }

  let custom = {};
  try { custom = JSON.parse(payment.transactions[0]?.custom || '{}'); } catch {}

  return {
    paid:     true,
    amount:   parseFloat(payment.transactions[0]?.amount?.total || 0),
    currency: payment.transactions[0]?.amount?.currency || 'USD',
    name:     custom.name    || donation.customer_name,
    email:    custom.email   || donation.customer_email,
    message:  custom.message || donation.message,
    provider_order_id: payment.id,
  };
}

// ─── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  try {
    // 1. Get donation row from Supabase
    const donation = await getDonation(order_id);
    if (!donation) return res.status(404).json({ error: 'Order not found' });

    // 2. Already paid — return immediately (idempotent)
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

    // 4. Still pending — check with provider
    let result;
    try {
      if (donation.provider === 'razorpay')    result = await checkRazorpay(donation);
      else if (donation.provider === 'paypal') result = await checkPaypal(donation);
      else                                     result = await checkCashfree(donation);
    } catch (err) {
      console.error(`[verify] provider check error (${donation.provider}):`, err.message);
      // Don't fail the poll — return pending so client retries
      return res.status(200).json({ paid: false, status: 'pending', error: err.message });
    }

    if (!result.paid) {
      return res.status(200).json({ paid: false, status: result.status || 'pending' });
    }

    // 5. Payment confirmed — fire StreamElements
    const se = await fireStreamElements({
      name:     result.name,
      email:    result.email,
      amount:   result.amount,
      currency: result.currency,
      message:  result.message,
      orderId:  order_id,
      provider: donation.provider,
    }).catch(err => ({ ok: false, data: { error: err.message } }));

    console.log(`[verify] ${order_id} PAID — SE fired: ${se.ok}`);

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
