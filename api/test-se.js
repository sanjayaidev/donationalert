export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  if (body?.password !== process.env.TEST_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const username = body.username ?? 'Sanjay Meher';
  const amount   = body.amount   ?? 99;
  const message  = body.message  ?? '🧪 Take the tip';
  const email    = body.email    ?? 'test@console.dev';
  const provider = body.provider ?? 'Cashfree'; // pass any string to test what SE accepts

  try {
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
            username,
            userId: 'cf-test-' + Date.now(),
            email,
          },
          provider,
          message,
          amount,
          currency: 'INR',
          imported: 'true',
        }),
      }
    );

    const data = await seRes.json();

    return res.status(200).json({
      success:     seRes.ok,
      se_status:   seRes.status,
      se_response: data,
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
