/**
 * /api/recent-donations.js
 *
 * Public, read-only endpoint for the donation feed cards on donate-popup.html.
 * Returns the last N *paid* donations with only the fields that are safe to
 * show publicly (no email, no order_id, no provider details).
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY server-side only — the key never reaches
 * the browser, so this stays safe even without Supabase RLS configured.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  // The StreamElements Custom Widget is served from StreamElements' own domain,
  // not ours — it needs CORS to be able to fetch this endpoint at all. The data
  // returned here is already public-safe, so an open origin is fine.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 3, 20);

  try {
    const url =
      `${SUPABASE_URL}/rest/v1/donations` +
      `?status=eq.paid` +
      `&select=customer_name,amount,currency,message,created_at,donation_type,media_url` +
      `&order=created_at.desc` +
      `&limit=${limit}`;

    const sbRes = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });

    const rows = await sbRes.json();
    if (!sbRes.ok || !Array.isArray(rows)) {
      throw new Error('Supabase read failed: ' + JSON.stringify(rows));
    }

    // Strip anything unexpected + never leak a null-message row as "null"
    const clean = rows.map((r) => ({
      customer_name: r.customer_name || 'Anonymous',
      amount: r.amount,
      currency: r.currency || 'INR',
      message: r.message || '',
      created_at: r.created_at,
      donation_type: r.donation_type || 'text',
      media_url: r.media_url || null,
    }));

    // Cache briefly at the edge so a burst of viewers doesn't hammer Supabase
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(200).json(clean);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
