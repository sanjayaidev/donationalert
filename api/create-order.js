export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, email, amount, message } = req.body;

  if (!name || !email || !amount || amount < 1) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Step 1: Create Cashfree order
  const orderId = 'tip-' + Date.now();

  const cfRes = await fetch('https://sandbox.cashfree.com/pg/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': '2023-08-01',
      'x-client-id':     process.env.CASHFREE_APP_ID,
      'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    },
    body: JSON.stringify({
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id:    'cust-' + Date.now(),
        customer_name:  name,
        customer_email: email,
        customer_phone: '9999999999',  // required by Cashfree, can make this a form field too
      },
      order_meta: {
        notify_url: process.env.WEBHOOK_URL,  // your Supabase edge function
        return_url: process.env.RETURN_URL + '?order_id=' + orderId,
      },
      order_tags: {
        message: message || '',
      }
    })
  });

  const order = await cfRes.json();

  if (!cfRes.ok) {
    console.error('Cashfree error:', order);
    return res.status(500).json({ error: 'Failed to create order', details: order });
  }

  return res.status(200).json({
    order_id: order.order_id,
    payment_session_id: order.payment_session_id,
  });
}
