export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { order_id, name, email, message } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  try {
    // 1. Fetch order status from Cashfree
    const cfRes = await fetch(
      `https://api.cashfree.com/pg/orders/${order_id}`,
      {
        headers: {
          'x-api-version': '2023-08-01',
          'x-client-id':     process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        },
      }
    );
    const order = await cfRes.json();

    if (!cfRes.ok) {
      return res.status(502).json({ error: 'Cashfree error', detail: order });
    }

    const status = order.order_status; // 'PAID' | 'ACTIVE' | 'EXPIRED' etc.

    if (status !== 'PAID') {
      return res.status(200).json({ paid: false, status });
    }

    // 2. Parse actual values from order
    const amount    = order.order_amount;
    const custName  = name  || order.customer_details?.customer_name  || 'Anonymous';
    const custEmail = email || order.customer_details?.customer_email || 'no@email.no';
    // message lives in order_tags (set during create-order)
    const tipMsg    = message || order.order_tags?.message || 'Thanks for the tip!';

    // 3. Send to StreamElements
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
            userId:   'cf-' + order_id,
            email:    custEmail,
          },
          provider:  'Cashfree',
          message:   tipMsg,
          amount,
          currency:  'INR',
          imported:  'true',
        }),
      }
    );
    const seData = await seRes.json();

    // 4. Log to Supabase edge function (fire-and-forget)
    fetch(process.env.WEBHOOK_URL + '/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id,
        amount,
        customer_name:  custName,
        customer_email: custEmail,
        status:         seRes.ok ? 'success' : 'se_error',
        se_response:    seData,
      }),
    }).catch(() => {}); // don't block response

    return res.status(200).json({
      paid: true,
      se_ok: seRes.ok,
      se_response: seData,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
