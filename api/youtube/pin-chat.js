import { google } from 'googleapis';

// ─── Supabase helper ────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseQuery(method, path, query = '') {
  const url = `${SUPABASE_URL}/rest/v1${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── OAuth2 Client Setup ─────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/youtube/callback`
);

// ─── Helper to get authenticated YouTube client ─────────────────────────────
async function getAuthenticatedYoutube(channelId) {
  // Fetch session from Supabase
  const sessions = await supabaseQuery('GET', '/youtube_sessions', `channel_id=eq.${channelId}&select=access_token,refresh_token,token_expiry&limit=1`);
  
  if (!sessions || sessions.length === 0) {
    throw new Error('No YouTube session found for this channel');
  }

  const session = sessions[0];
  
  // Check if token is expired or about to expire (within 5 minutes)
  const now = Date.now();
  const expiryTime = session.token_expiry ? new Date(session.token_expiry).getTime() : 0;
  const needsRefresh = !session.access_token || (expiryTime && expiryTime - now < 5 * 60 * 1000);

  if (needsRefresh && session.refresh_token) {
    // Refresh the access token
    oauth2Client.setCredentials({ refresh_token: session.refresh_token });
    const { credentials } = await oauth2Client.refreshAccessToken();
    
    // Update session in Supabase with new tokens
    await updateSessionTokens(channelId, credentials.access_token, credentials.expiry_date);
    
    oauth2Client.setCredentials(credentials);
  } else {
    oauth2Client.setCredentials({ 
      access_token: session.access_token,
      refresh_token: session.refresh_token 
    });
  }

  return google.youtube({ version: 'v3', auth: oauth2Client });
}

async function updateSessionTokens(channelId, accessToken, expiryDate) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/youtube_sessions`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({
      access_token: accessToken,
      token_expiry: expiryDate ? new Date(expiryDate).toISOString() : null,
    }),
    query: `channel_id=eq.${channelId}`,
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update tokens: ${res.status}: ${text}`);
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { channelId, messageId } = req.body;

    if (!channelId) {
      return res.status(400).json({ error: 'Channel ID is required', code: 'MISSING_CHANNEL_ID' });
    }

    if (!messageId) {
      return res.status(400).json({ error: 'Message ID is required', code: 'MISSING_MESSAGE_ID' });
    }

    // Get authenticated YouTube client
    const youtube = await getAuthenticatedYoutube(channelId);

    // Find active live broadcast for this channel
    const broadcastsResponse = await youtube.liveBroadcasts.list({
      part: 'id,liveStreamingDetails',
      mine: true,
      broadcastStatus: 'active',
    });

    const activeBroadcast = broadcastsResponse.data.items?.[0];

    if (!activeBroadcast) {
      return res.status(400).json({ 
        error: 'No active live broadcast found', 
        code: 'NO_ACTIVE_BROADCAST' 
      });
    }

    const liveChatId = activeBroadcast.liveStreamingDetails?.activeLiveChatId;

    if (!liveChatId) {
      return res.status(400).json({ 
        error: 'Live chat is not available for this broadcast', 
        code: 'CHAT_NOT_AVAILABLE' 
      });
    }

    // First, retrieve the message to get its text
    const messagesResponse = await youtube.liveChatMessages.list({
      liveChatId: liveChatId,
      part: 'snippet,id',
    });

    const targetMessage = messagesResponse.data.items?.find(msg => msg.id === messageId);

    if (!targetMessage) {
      return res.status(404).json({ 
        error: 'Message not found in live chat', 
        code: 'MESSAGE_NOT_FOUND' 
      });
    }

    // Extract the original message text
    const originalText = targetMessage.snippet?.textMessageDetails?.messageText;
    
    if (!originalText) {
      return res.status(400).json({ 
        error: 'Cannot pin this type of message', 
        code: 'INVALID_MESSAGE_TYPE' 
      });
    }

    // Pin the message using liveChatModerator
    await youtube.liveChatModerators.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          liveChatId: liveChatId,
          type: 'pinnedMessageEvent',
          pinnedMessageDetails: {
            messageId: messageId,
          },
        },
      },
    });

    res.status(200).json({
      success: true,
      messageId,
      action: 'pinned',
      message: originalText,
      broadcastId: activeBroadcast.id,
    });

  } catch (error) {
    console.error('Pin chat message error:', error);

    if (error.message.includes('No YouTube session')) {
      return res.status(404).json({ 
        error: 'YouTube channel not connected', 
        code: 'CHANNEL_NOT_CONNECTED' 
      });
    }

    if (error.message.includes('No active live broadcast')) {
      return res.status(400).json({ 
        error: error.message, 
        code: 'NO_ACTIVE_BROADCAST' 
      });
    }

    if (error.code === 403 || error.message.includes('forbidden')) {
      return res.status(403).json({ 
        error: 'Insufficient permissions to moderate chat', 
        code: 'INSUFFICIENT_PERMISSIONS' 
      });
    }

    if (error.code === 404 || error.message.includes('not found')) {
      return res.status(404).json({ 
        error: 'Message or broadcast not found', 
        code: 'NOT_FOUND' 
      });
    }

    res.status(500).json({ 
      error: 'Failed to pin chat message', 
      code: 'PIN_MESSAGE_ERROR',
      details: error.message 
    });
  }
}
