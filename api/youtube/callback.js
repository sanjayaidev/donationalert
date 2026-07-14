import { google } from 'googleapis';

// ─── Supabase helper ────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabase(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=minimal',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  }
  return res;
}

// Upsert helper: relies on a UNIQUE constraint on the conflict column(s)
// (e.g. channel_id) already existing in the table.
async function supabaseUpsert(path, body, conflictColumn) {
  return supabase(
    'POST',
    `${path}?on_conflict=${conflictColumn}`,
    body,
    { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
  );
}

// Fetch a single existing row (used to preserve refresh_token on reconnect)
async function supabaseSelectOne(path, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}?${filter}&select=*`, {
    method: 'GET',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${path} → ${res.status}: ${text}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

// ─── OAuth2 Client Setup ─────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/youtube/callback`
);

// ─── Process OAuth code and store session ────────────────────────────────────
async function processOAuthCode(code) {
  // Exchange authorization code for tokens
  const { tokens } = await oauth2Client.getToken(code);

  // Set credentials for the OAuth2 client
  oauth2Client.setCredentials(tokens);

  // Get YouTube channel information
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const userinfo = google.oauth2({ version: 'v2', auth: oauth2Client });

  // Fetch channel details
  const [channelResponse, userInfoResponse] = await Promise.all([
    youtube.channels.list({
      part: 'snippet,id',
      mine: true,
    }),
    userinfo.userinfo.get(),
  ]);

  const channel = channelResponse.data.items?.[0];
  const user = userInfoResponse.data;

  if (!channel) {
    throw new Error('No YouTube channel found');
  }

  const channelId = channel.id;
  const channelName = channel.snippet.title;
  const channelThumbnail = channel.snippet.thumbnails?.default?.url;

  // Google only reissues a refresh_token on the first consent for a given
  // user+app pair. If this is a reconnect and Google didn't send one,
  // preserve whatever refresh_token we already have on file.
  let refreshToken = tokens.refresh_token || null;

  if (!refreshToken) {
    const existing = await supabaseSelectOne(
      '/youtube_sessions',
      `channel_id=eq.${encodeURIComponent(channelId)}`
    );
    if (existing?.refresh_token) {
      refreshToken = existing.refresh_token;
    }
  }

  // Upsert session in Supabase youtube_sessions table
  // (requires a UNIQUE constraint on channel_id, which you already have)
  await supabaseUpsert('/youtube_sessions', {
    channel_id: channelId,
    channel_name: channelName,
    channel_thumbnail: channelThumbnail || null,
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    scope: tokens.scope || '',
    user_email: user.email || null,
    user_name: user.name || null,
    updated_at: new Date().toISOString(),
  }, 'channel_id');

  return {
    success: true,
    channelId,
    channelName,
    channelThumbnail,
    message: 'YouTube channel connected successfully',
  };
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Handle GET request from OAuth redirect
  if (req.method === 'GET') {
    const { code, error, state } = req.query;

    if (error) {
      // Redirect back to login page with error
      return res.redirect(`/yt-login.html?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required', code: 'MISSING_CODE' });
    }

    try {
      const result = await processOAuthCode(code);
      // Redirect to login page with success
      return res.redirect(`/yt-login.html?success=true&channelId=${result.channelId}&channelName=${encodeURIComponent(result.channelName)}`);
    } catch (error) {
      console.error('YouTube OAuth callback error:', error);
      return res.redirect(`/yt-login.html?error=${encodeURIComponent(error.message)}`);
    }
  }

  // Handle POST request from frontend (for testing/manual flow)
  if (req.method === 'POST') {
    try {
      const { code } = req.body;

      if (!code) {
        return res.status(400).json({ error: 'Authorization code is required', code: 'MISSING_CODE' });
      }

      const result = await processOAuthCode(code);
      return res.status(200).json(result);

    } catch (error) {
      console.error('YouTube OAuth callback error:', error);

      if (error.message.includes('Supabase')) {
        return res.status(500).json({
          error: 'Failed to store session in database',
          code: 'DATABASE_ERROR',
          details: error.message
        });
      }

      if (error.code === 401 || error.message.includes('invalid_grant')) {
        return res.status(401).json({
          error: 'Invalid authorization code',
          code: 'INVALID_CODE'
        });
      }

      return res.status(500).json({
        error: 'Failed to connect YouTube channel',
        code: 'CONNECTION_ERROR',
        details: error.message
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
