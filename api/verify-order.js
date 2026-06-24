/**
 * /api/verify-order.js
 *
 * Lightweight status check — reads from Supabase only.
 * The actual payment verification is done by the cron poller (poll-payments.js).
 * thankyou.html polls this endpoint until status is 'paid' or 'failed'.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/donations?order_id=eq.${encodeURIComponent(order_id)}&select=*&limit=1`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );

    const rows = await sbRes.json();

    if (!sbRes.ok || !Array.isArray(rows)) {
      return res.status(502).json({ error: 'Supabase error', detail: rows });
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const donation = rows[0];

    return res.status(200).json({
      paid:     donation.status === 'paid',
      status:   donation.status,
      provider: donation.provider,
      amount:   donation.amount,
      currency: donation.currency,
      se_fired: donation.se_fired,
    });

  } catch (err) {
    console.error('[verify-order]', err);
    return res.status(500).json({ error: err.message });
  }
}
