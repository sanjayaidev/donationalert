# YouTube Integration Setup Guide

This guide will help you set up YouTube OAuth2 integration for your StreamTip app.

## Prerequisites

1. **Google Cloud Console Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one

2. **Enable YouTube Data API v3**
   - In Google Cloud Console, go to "APIs & Services" > "Library"
   - Search for "YouTube Data API v3" and enable it

3. **Create OAuth 2.0 Credentials**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Application type: **Web application**
   - Add authorized redirect URI: `https://your-domain.com/api/youtube/callback`
     - For local development: `http://localhost:3000/api/youtube/callback`
   - Save the Client ID and Client Secret

4. **Supabase Database Setup**

   Create a new table called `youtube_sessions` in your Supabase database:

   ```sql
   -- Create youtube_sessions table
   CREATE TABLE IF NOT EXISTS youtube_sessions (
     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
     channel_id TEXT UNIQUE NOT NULL,
     channel_name TEXT NOT NULL,
     channel_thumbnail TEXT,
     access_token TEXT NOT NULL,
     refresh_token TEXT,
     token_expiry TIMESTAMPTZ,
     scope TEXT,
     user_email TEXT,
     user_name TEXT,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     updated_at TIMESTAMPTZ DEFAULT NOW()
   );

   -- Create index on channel_id for faster lookups
   CREATE INDEX IF NOT EXISTS idx_youtube_sessions_channel_id ON youtube_sessions(channel_id);

   -- Enable Row Level Security (optional but recommended)
   ALTER TABLE youtube_sessions ENABLE ROW LEVEL SECURITY;

   -- Create policy to allow service role to manage all records
   CREATE POLICY "Service role can manage youtube_sessions" 
   ON youtube_sessions 
   FOR ALL 
   USING (true);
   ```

5. **Environment Variables**

   Add these environment variables to your Vercel project settings:

   ```env
   # Supabase Configuration
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

   # YouTube OAuth2 Configuration
   YOUTUBE_CLIENT_ID=your-client-id-from-google-cloud
   YOUTUBE_CLIENT_SECRET=your-client-secret-from-google-cloud
   YOUTUBE_REDIRECT_URI=https://your-domain.com/api/youtube/callback
   ```

   For local development, create a `.env.local` file:

   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   YOUTUBE_CLIENT_ID=your-client-id
   YOUTUBE_CLIENT_SECRET=your-client-secret
   YOUTUBE_REDIRECT_URI=http://localhost:3000/api/youtube/callback
   ```

6. **Update yt-login.html**

   Replace `{{YOUTUBE_CLIENT_ID}}` in `/yt-login.html` with your actual YouTube Client ID from Google Cloud Console.

## API Routes

### 1. OAuth Callback (`/api/youtube/callback.js`)
Handles the OAuth2 callback and stores session tokens in Supabase.

**POST** `/api/youtube/callback`
```json
{
  "code": "authorization_code_from_google"
}
```

### 2. Send Chat Message (`/api/youtube/send-chat.js`)
Sends a message to the live chat of an active broadcast.

**POST** `/api/youtube/send-chat`
```json
{
  "channelId": "UC...",
  "message": "Hello from StreamTip!"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "chat-message-id",
  "broadcastId": "broadcast-id",
  "message": "Hello from StreamTip!",
  "publishedAt": "2024-01-01T00:00:00Z"
}
```

### 3. Pin Chat Message (`/api/youtube/pin-chat.js`)
Pins a chat message in the live stream.

**POST** `/api/youtube/pin-chat`
```json
{
  "channelId": "UC...",
  "messageId": "chat-message-id-to-pin"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "chat-message-id",
  "action": "pinned",
  "message": "Original message text",
  "broadcastId": "broadcast-id"
}
```

### 4. Delete Chat Message (`/api/youtube/delete-chat.js`)
Deletes a chat message from the live stream.

**POST** `/api/youtube/delete-chat`
```json
{
  "channelId": "UC...",
  "messageId": "chat-message-id-to-delete"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "chat-message-id",
  "action": "deleted",
  "broadcastId": "broadcast-id"
}
```

## Usage Example

### Connecting a YouTube Channel

1. Navigate to `/yt-login.html`
2. Click "Connect with YouTube"
3. Authorize the application
4. Session is stored in Supabase automatically

### Sending a Chat Message (Client-side)

```javascript
async function sendChatMessage(channelId, message) {
  const response = await fetch('/api/youtube/send-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, message })
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error);
  }
  
  return data;
}

// Usage
sendChatMessage('UC-your-channel-id', 'Thanks for the donation!')
  .then(console.log)
  .catch(console.error);
```

### Pinning a Chat Message

```javascript
async function pinChatMessage(channelId, messageId) {
  const response = await fetch('/api/youtube/pin-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, messageId })
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error);
  }
  
  return data;
}

// Usage
pinChatMessage('UC-your-channel-id', 'message-id-to-pin')
  .then(console.log)
  .catch(console.error);
```

## Important Notes

1. **Token Refresh**: The API automatically handles token refresh when access tokens expire.

2. **Active Broadcast Required**: Chat operations only work when there's an active live broadcast.

3. **Permissions**: The connected YouTube account must have permission to manage live chat for the channel.

4. **Rate Limits**: YouTube API has rate limits. Monitor your quota usage in Google Cloud Console.

5. **Security**: Never expose your `YOUTUBE_CLIENT_SECRET` or `SUPABASE_SERVICE_ROLE_KEY` in client-side code.

## Troubleshooting

### Common Errors

- **NO_ACTIVE_BROADCAST**: Start a live stream before sending chat messages
- **CHANNEL_NOT_CONNECTED**: Re-connect the YouTube channel via `/yt-login.html`
- **INSUFFICIENT_PERMISSIONS**: Ensure the OAuth scopes include `youtube.force-ssl`
- **INVALID_CODE**: The authorization code has expired (codes are valid for ~10 minutes)

### Testing Locally

```bash
# Install dependencies
npm install

# Start Vercel dev server
npm run dev
```

Visit `http://localhost:3000/yt-login.html` to test the OAuth flow.
