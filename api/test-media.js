/**
 * /api/test-media.js
 *
 * Test endpoint to trigger media (image/audio) alerts for StreamElements.
 * This simulates what happens when a donation with media type is verified.
 * 
 * Usage from browser console on donate-popup page:
 * 
 * // Test image alert
 * fetch('/api/test-media', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     password: 'your-TEST_PASSWORD-here',
 *     type: 'image',
 *     name: 'Test User',
 *     amount: 300,
 *     message: '🖼️ Check out this image!',
 *     mediaUrl: 'https://your-supabase-project.supabase.co/storage/v1/object/public/donation-media/test-image.png'
 *   })
 * }).then(r => r.json()).then(console.log);
 * 
 * // Test audio alert
 * fetch('/api/test-media', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     password: 'your-TEST_PASSWORD-here',
 *     type: 'audio',
 *     name: 'Test User',
 *     amount: 200,
 *     message: '🔊 Listen to this!',
 *     mediaUrl: 'https://your-supabase-project.supabase.co/storage/v1/object/public/donation-audio/test-audio.mp3'
 *   })
 * }).then(r => r.json()).then(console.log);
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  
  if (body?.password !== process.env.TEST_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const {
    type = 'image',
    name = 'Test User',
    amount = 300,
    message = '🧪 Test media alert',
    mediaUrl = '',
    email = 'test@console.dev'
  } = body || {};

  if (!['image', 'audio'].includes(type)) {
    return res.status(400).json({ error: 'type must be "image" or "audio"' });
  }

  try {
    // Fire StreamElements tip event with media info encoded in the message
    // The custom SE widget will parse this and display image/audio accordingly
    const seMessage = `[${type.toUpperCase()}]${message}${mediaUrl ? ' |MEDIA:' + mediaUrl : ''}`;
    
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
            username: name,
            userId: 'cf-media-test-' + Date.now(),
            email,
          },
          provider: 'TestMedia',
          message: seMessage,
          amount,
          currency: 'INR',
          imported: 'true',
        }),
      }
    );

    const data = await seRes.json();

    return res.status(200).json({
      success: seRes.ok,
      se_status: seRes.status,
      se_response: data,
      test_info: {
        type,
        name,
        amount,
        message,
        mediaUrl,
        se_message_sent: seMessage,
      },
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
