/**
 * /api/media-upload-url.js
 *
 * Returns a short-lived Supabase Storage "signed upload URL" so the browser
 * can PUT the raw file bytes straight to Storage — never through this
 * Vercel function. This matters because Vercel Serverless Functions cap
 * request bodies at ~4.5MB; base64-encoding a multi-MB audio/image file
 * would blow past that. The signed token is scoped to exactly one object
 * path and expires in 10 minutes, and the Supabase service role key never
 * leaves the server.
 */

import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKETS = {
  image: 'donation-media',
  audio: 'donation-audio',
};

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
};

function safeExt(fileName, fileType) {
  const fromMime = EXT_BY_MIME[fileType];
  if (fromMime) return fromMime;
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(fileName || '');
  return match ? match[1].toLowerCase() : 'bin';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase credentials not configured on the server' });
  }

  const { kind, fileName, fileType, fileSize } = req.body || {};
  if (kind !== 'image' && kind !== 'audio') {
    return res.status(400).json({ error: "kind must be 'image' or 'audio'" });
  }

  // Server-side size guardrails (mirrors the popup's own limits, but this is
  // the check that actually matters since the client-side one is easy to bypass)
  const MAX_BYTES = kind === 'image' ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
  if (typeof fileSize === 'number' && fileSize > MAX_BYTES) {
    return res.status(400).json({ error: `File too large — max ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB for ${kind}` });
  }

  const bucket = BUCKETS[kind];
  const ext    = safeExt(fileName, fileType);
  const path   = `pending/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

  try {
    const signRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${path}`,
      {
        method: 'POST',
        headers: {
          apikey:          SUPABASE_KEY,
          Authorization:   `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ expiresIn: 600 }), // 10 minutes — plenty for an upload, short enough to limit abuse
      }
    );
    const data = await signRes.json();
    if (!signRes.ok || !data.url) {
      console.error('[media-upload-url] sign error', { status: signRes.status, data });
      return res.status(502).json({ error: 'Failed to create signed upload URL', detail: data });
    }

    return res.status(200).json({
      uploadUrl:  `${SUPABASE_URL}/storage/v1${data.url}`,
      publicUrl:  `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`,
      bucket,
      path,
      maxBytes:   MAX_BYTES,
    });
  } catch (err) {
    console.error('[media-upload-url] exception', err);
    return res.status(500).json({ error: err.message });
  }
}