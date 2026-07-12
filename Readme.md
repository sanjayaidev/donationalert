# StreamTip — Live Donation System for YouTube Streamers

A complete donation/tip system for YouTube live streamers. Viewers tip via a beautiful web page, payment is verified automatically, StreamElements alert fires on stream, and a message appears in YouTube Live chat.

---

## Features

| Feature | Detail |
|---|---|
| Payment Gateways | Cashfree, Razorpay, PayPal, Stripe |
| Stream Alerts | StreamElements tip alert with donor name, amount, message |
| YouTube Live Chat | Auto posts tip message in your live chat |
| Supabase Logging | Every donation stored with status (pending/paid/failed) |
| Polling Verification | No webhooks — client polls until payment confirmed |
| SE Overlay Widget | Custom widget displays tip message on OBS |
| Multi-step tip form | Name → Amount → Review → Pay |
| YouTube embed | Load any YouTube stream via URL or video ID |
| StreamElements chat | Load SE chat overlay in sidebar |
| Test/Sandbox mode | Switch between test and production via env var |

---

## Architecture

```
Viewer fills tip form
        ↓
POST /api/create-order
        ↓
Payment gateway (Cashfree / Razorpay / PayPal)
        ↓
Redirect to /thankyou
        ↓
thankyou.html polls /api/verify-order every 3s
        ↓
verify-order.js checks payment status with provider
        ↓ (on success)
┌───────────────────────────────────────┐
│  StreamElements Tip API               │  → SE alert fires on OBS overlay
│  YouTube Live Chat API (via CG Live)  │  → Message posted in live chat
│  Supabase donations table             │  → Row updated to 'paid'
└───────────────────────────────────────┘
```

---

## Project Structure

```
/
├── index.html              # Main stream page with embedded donate button widget (served at /)
├── donate-popup.html       # Standalone popup overlay page (served at /donate)
├── donate.js               # Self-contained donate button + text-only popup widget
├── thankyou.html           # Payment verification + polling page
├── vercel.json             # Vercel config (build command + rewrites)
├── api/
│   ├── create-order.js     # Creates order with payment provider + inserts pending row
│   ├── verify-order.js     # Polls provider, fires SE + YT chat, updates Supabase
│   ├── recent-donations.js # Fetches recent paid donations for the feed
│   ├── media-upload-url.js # Generates signed URLs for Supabase storage uploads
│   ├── test-se.js          # Debug endpoint to fire a test SE text tip
│   └── test-media.js       # Debug endpoint to fire test SE image/audio tips
```

---

## Prerequisites

- [Vercel](https://vercel.com) account (free tier works)
- [Supabase](https://supabase.com) account (free tier works)
- [StreamElements](https://streamelements.com) account
- At least one payment gateway account (Cashfree recommended for India)
- (Optional) [CG Live app](https://cggodotassets.shop/cglive) for YouTube Live chat integration

---

## Step 1 — Supabase Setup

### 1.1 Create the donations table

Go to **Supabase Dashboard → SQL Editor** and run:

```sql
create table if not exists donations (
  id                uuid primary key default gen_random_uuid(),
  order_id          text not null unique,
  provider          text not null,
  provider_order_id text,
  status            text not null default 'pending',
  amount            numeric(10,2) not null,
  currency          text not null default 'INR',
  customer_name     text,
  customer_email    text,
  message           text,
  se_fired          boolean not null default false,
  se_response       jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists donations_pending_idx
  on donations (status, created_at)
  where status = 'pending';

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger donations_updated_at
  before update on donations
  for each row execute function update_updated_at();
```

### 1.2 Get your Supabase credentials

Go to **Supabase Dashboard → Settings → API** and copy:
- `Project URL` → `SUPABASE_URL`
- `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY`

---

## Step 2 — Payment Gateway Setup

### Cashfree (recommended for India)
1. Create account at [cashfree.com](https://cashfree.com)
2. Go to **Developers → API Keys**
3. For testing: copy keys from **Sandbox** tab
4. For production: copy keys from **Production** tab

### Razorpay
1. Create account at [razorpay.com](https://razorpay.com)
2. Go to **Settings → API Keys → Generate Key**
3. For testing: use Test mode keys (`rzp_test_...`)
4. For production: use Live mode keys (`rzp_live_...`)

### PayPal
1. Create app at [developer.paypal.com](https://developer.paypal.com)
2. Go to **My Apps & Credentials**
3. For testing: use Sandbox credentials
4. For production: use Live credentials

### Stripe
1. Create account at [stripe.com](https://stripe.com)
2. Go to **Developers → API Keys**
3. For testing: copy the **Secret key** starting with `sk_test_...` → `STRIPE_TEST_SECRET_KEY`
4. For production: copy the **Secret key** starting with `sk_live_...` → `STRIPE_SECRET_KEY`
5. No webhook setup needed — same as the other gateways, `thankyou.html` polls `/api/verify-order`, which confirms payment directly with Stripe's Checkout Sessions API.

---

## Step 3 — StreamElements Setup

### 3.1 Get your Channel ID and JWT Token
1. Go to [streamelements.com](https://streamelements.com) → **Account → Channel**
2. Copy your **Channel ID** → `SE_CHANNEL_ID`
3. Go to **Account → Access Token** → copy JWT → `SE_JWT_TOKEN`

### 3.2 Add the Overlay Widget (Text Tips)

1. Go to **StreamElements → Overlays → Editor**
2. Add a **Custom Widget**
3. Paste the following into each tab:

**HTML**
```html
<div id="wrap" style="display:none">
  <div id="name"></div>
  <div id="amount"></div>
  <div id="message"></div>
</div>
```

**CSS**
```css
#wrap {
  background: rgba(36,6,73,0.85);
  border: 1px solid #6c63ff;
  border-radius: 12px;
  padding: 14px 18px;
  font-family: 'JetBrains Mono', monospace;
  color: #fff;
  max-width: 400px;
  animation: fadeIn 0.4s ease;
}
#name {
  font-size: 13px;
  color: #9b94ff;
  font-weight: 700;
  margin-bottom: 4px;
}
#amount {
  font-size: 22px;
  font-weight: 700;
  color: #c8c4ff;
  margin-bottom: 8px;
}
#message {
  font-size: 13px;
  color: #e8e8f8;
  line-height: 1.6;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}
```

**JS**
```js
window.addEventListener('onEventReceived', function(obj) {
  const listener = obj.detail.listener;
  const event    = obj.detail.event;
  if (listener !== 'tip-latest') return;
  const name    = event.name    || event.username || 'Anonymous';
  const amount  = event.amount  || 0;
  const message = event.message || '';
  if (!message.trim()) return;
  document.getElementById('name').innerText    = name + ' tipped ₹' + amount;
  document.getElementById('amount').innerText  = '';
  document.getElementById('message').innerText = '💬 ' + message;
  const wrap = document.getElementById('wrap');
  wrap.style.display = 'block';
  clearTimeout(wrap._timer);
  wrap._timer = setTimeout(() => { wrap.style.display = 'none'; }, 8000);
});
```

**Fields**
```json
{}
```

4. Save the overlay and copy the **Overlay URL**
5. Add as a **Browser Source** in OBS

---

### 3.3 Custom Media Widget (Image + Audio + Text)

This widget displays images from Supabase storage, plays audio files, and shows text messages. It parses special `[IMAGE]` or `[AUDIO]` prefixes from the tip message along with a `|MEDIA:` URL suffix.

1. Go to **StreamElements → Overlays → Editor**
2. Add a new **Custom Widget** (separate from the text widget above)
3. Paste the following into each tab:

**HTML**
```html
<div id="media-wrap" style="display:none">
  <div id="media-name"></div>
  <div id="media-amount"></div>
  <div id="media-content"></div>
  <div id="media-message"></div>
</div>
```

**CSS**
```css
#media-wrap {
  background: rgba(36,6,73,0.92);
  border: 1px solid #a855f7;
  border-radius: 16px;
  padding: 18px 22px;
  font-family: 'JetBrains Mono', monospace;
  color: #fff;
  max-width: 500px;
  animation: mediaFadeIn 0.5s ease;
}
#media-name {
  font-size: 14px;
  color: #d8aaff;
  font-weight: 700;
  margin-bottom: 6px;
}
#media-amount {
  font-size: 24px;
  font-weight: 800;
  color: #ffb020;
  margin-bottom: 12px;
  text-shadow: 0 0 12px rgba(255,176,32,0.5);
}
#media-content {
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  background: rgba(0,0,0,0.3);
  border-radius: 10px;
  overflow: hidden;
}
#media-content img {
  max-width: 100%;
  max-height: 280px;
  object-fit: contain;
}
#media-content audio {
  width: 100%;
  outline: none;
}
#media-message {
  font-size: 13px;
  color: #e8e8f8;
  line-height: 1.6;
}
@keyframes mediaFadeIn {
  from { opacity: 0; transform: scale(0.95) translateY(10px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
```

**JS**
```js
(function() {
  let cleanupTimer = null;
  
  function cleanupContent() {
    const content = document.getElementById('media-content');
    if (!content) return;
    content.innerHTML = '';
  }
  
  window.addEventListener('onEventReceived', function(obj) {
    const listener = obj.detail.listener;
    const event    = obj.detail.event;
    if (listener !== 'tip-latest') return;
    
    const name    = event.name    || event.username || 'Anonymous';
    const amount  = event.amount  || 0;
    let message   = event.message || '';
    
    if (!message.trim()) return;
    
    // Parse media type prefix [IMAGE] or [AUDIO]
    let mediaType = null;
    let mediaUrl = null;
    
    const imageMatch = message.match(/^\[IMAGE\]/i);
    const audioMatch = message.match(/^\[AUDIO\]/i);
    
    if (imageMatch) {
      mediaType = 'image';
      message = message.replace(/^\[IMAGE\]/i, '').trim();
    } else if (audioMatch) {
      mediaType = 'audio';
      message = message.replace(/^\[AUDIO\]/i, '').trim();
    }
    
    // Extract media URL from |MEDIA: suffix
    const mediaUrlMatch = message.match(/\|MEDIA:(.+)$/);
    if (mediaUrlMatch) {
      mediaUrl = mediaUrlMatch[1].trim();
      message = message.replace(mediaUrlMatch[0], '').trim();
    }
    
    // Update header info
    document.getElementById('media-name').innerText   = name + ' tipped ₹' + amount;
    document.getElementById('media-amount').innerText = '';
    
    const contentDiv = document.getElementById('media-content');
    const messageDiv = document.getElementById('media-message');
    
    // Clear previous content
    cleanupContent();
    
    // Render based on media type
    if (mediaType === 'image' && mediaUrl) {
      const img = document.createElement('img');
      img.src = mediaUrl;
      img.alt = 'Donation image';
      contentDiv.appendChild(img);
    } else if (mediaType === 'audio' && mediaUrl) {
      const audio = document.createElement('audio');
      audio.src = mediaUrl;
      audio.controls = true;
      audio.autoplay = true;
      contentDiv.appendChild(audio);
    }
    
    // Show message (text is always supported alongside media)
    messageDiv.innerText = message ? '💬 ' + message : '';
    
    const wrap = document.getElementById('media-wrap');
    wrap.style.display = 'block';
    
    // Auto-hide after 12 seconds (longer for media)
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      wrap.style.display = 'none';
      cleanupContent();
    }, 12000);
  });
})();
```

**Fields**
```json
{}
```

4. Save the overlay and copy the **Overlay URL**
5. Add as a separate **Browser Source** in OBS (position it where you want media alerts to appear)

> **Note:** This widget works with both regular text tips AND media tips. When a donor uploads an image or audio file, the message will include `[IMAGE]` or `[AUDIO]` prefix plus a `|MEDIA:url` suffix that this widget parses automatically.


---

## Step 4 — YouTube Live Chat (Optional)

This requires the **CG Live app** installed on your Android device.

1. Download and open [CG Live](https://cggodotassets.shop/cglive)
2. Connect your YouTube account inside the app
3. Go to **Settings → Device ID** and copy your Device UID
4. Add it as `STREAMER_DEVICE_UID` in Vercel env vars

When a donation comes in, the system will automatically:
- Find your active broadcast
- Get the live chat ID
- Post `@name tipped ₹amount -- message` in your YouTube Live chat

> If you are not using CG Live or have no active broadcast, this step is silently skipped — payments still work normally.

---

## Step 5 — Deploy to Vercel

### 5.1 Push to GitHub
Push the project to a GitHub repository.

### 5.2 Import to Vercel
1. Go to [vercel.com](https://vercel.com) → **New Project**
2. Import your GitHub repository
3. Framework Preset: **Other**
4. Leave build settings as-is (vercel.json handles everything)

### 5.3 Add Environment Variables

Go to **Vercel → Project → Settings → Environment Variables** and add:

#### Required
| Variable | Description |
|---|---|
| `PRODUCTION_MODE` | `true` for live, `false` for sandbox/test |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret |
| `SE_CHANNEL_ID` | StreamElements channel ID |
| `SE_JWT_TOKEN` | StreamElements JWT token |

#### Cashfree
| Variable | Description |
|---|---|
| `CASHFREE_APP_ID` | Production App ID |
| `CASHFREE_SECRET_KEY` | Production Secret Key |
| `CASHFREE_SANDBOX_APP_ID` | Sandbox App ID (test mode) |
| `CASHFREE_SANDBOX_SECRET_KEY` | Sandbox Secret Key (test mode) |

#### Razorpay
| Variable | Description |
|---|---|
| `RAZORPAY_KEY_ID` | Live Key ID |
| `RAZORPAY_KEY_SECRET` | Live Key Secret |
| `RAZORPAY_TEST_KEY_ID` | Test Key ID |
| `RAZORPAY_TEST_KEY_SECRET` | Test Key Secret |

#### PayPal
| Variable | Description |
|---|---|
| `PAYPAL_CLIENT_ID` | Live Client ID |
| `PAYPAL_CLIENT_SECRET` | Live Client Secret |
| `PAYPAL_SANDBOX_CLIENT_ID` | Sandbox Client ID |
| `PAYPAL_SANDBOX_CLIENT_SECRET` | Sandbox Client Secret |

#### Stripe
| Variable | Description |
|---|---|
| `STRIPE_SECRET_KEY` | Live Secret Key (`sk_live_...`) |
| `STRIPE_TEST_SECRET_KEY` | Test Secret Key (`sk_test_...`) |
| `STRIPE_CURRENCY` | Optional. Checkout currency, e.g. `usd` (default) or `inr` |

#### Stream Config
| Variable | Description |
|---|---|
| `DEFAULT_YOUTUBE_URL` | Your YouTube channel/stream URL (auto-loads on page open) |
| `SE_CHAT_URL` | Your StreamElements overlay chat URL |
| `STREAMER_DEVICE_UID` | CG Live app Device UID (optional, for YT chat) |

#### Testing
| Variable | Description |
|---|---|
| `TEST_PASSWORD` | Password required to trigger test SE alerts via `/api/test-se` and `/api/test-media` endpoints |

### 5.4 Deploy
Click **Deploy**. Vercel will build and deploy automatically.

---

## Step 6 — Test the Setup

### Using the Donate Button Widget (index.html)

When you visit your Vercel URL (`/`), you'll see the main stream page with a floating **"SUPPORT THE STREAM"** button in the bottom-right corner. Click it to open the text-only donation popup.

**Features:**
- Animated gradient button with pulse effect
- Text-only donations (no tiers, no rewards system)
- Same payment flow as the full donate-popup page
- Redirects to `payment.html` on submit

### Test payment creation (browser console on your site)
```js
fetch('/api/create-order', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Test User',
    email: 'test@test.com',
    amount: 10,
    message: 'test tip',
    provider: 'cashfree'
  })
}).then(r => r.json()).then(console.log)
```
You should get back a `payment_session_id`.

### Test SE alert (text tip)
```js
fetch('/api/test-se', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'your-TEST_PASSWORD-here' })
}).then(r => r.json()).then(console.log)
```

### Test media alerts (image/audio) — from donate-popup page console

First, set your `TEST_PASSWORD` environment variable in Vercel. Then open the browser console on your donate-popup page (`/donate`) and run:

**Test Image Alert**
```js
testImageAlert('Test User', 300, '🖼️ Check out this image!', 'https://your-supabase-project.supabase.co/storage/v1/object/public/donation-media/test-image.png')
```

**Test Audio Alert**
```js
testAudioAlert('Test User', 200, '🔊 Listen to this!', 'https://your-supabase-project.supabase.co/storage/v1/object/public/donation-audio/test-audio.mp3')
```

Or use raw fetch calls:

```js
// Test image
fetch('/api/test-media', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    password: 'your-TEST_PASSWORD-here',
    type: 'image',
    name: 'Test User',
    amount: 300,
    message: '🖼️ Test image from console!',
    mediaUrl: 'https://your-supabase-project.supabase.co/storage/v1/object/public/donation-media/test-image.png'
  })
}).then(r => r.json()).then(console.log)

// Test audio
fetch('/api/test-media', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    password: 'your-TEST_PASSWORD-here',
    type: 'audio',
    name: 'Test User',
    amount: 200,
    message: '🔊 Test audio from console!',
    mediaUrl: 'https://your-supabase-project.supabase.co/storage/v1/object/public/donation-audio/test-audio.mp3'
  })
}).then(r => r.json()).then(console.log)
```

> **Note:** The test functions `testImageAlert()` and `testAudioAlert()` are automatically available in the browser console when you load the donate-popup page (`/donate`). They will prompt you for the TEST_PASSWORD before sending.

---

## How Payment Verification Works

No webhooks needed. The flow is:

```
1. Donor pays → thankyou.html opens
2. thankyou.html polls /api/verify-order every 3 seconds
3. verify-order.js checks order status with payment provider API
4. On success:
   - StreamElements tip API called → alert fires on stream
   - YouTube Live chat message posted (if CG Live connected)
   - Supabase donations row updated to 'paid'
   - thankyou.html shows success screen
5. After 5 minutes with no success → marked as failed
```

---

## Viewing Donations

Go to **Supabase Dashboard → Table Editor → donations** to see all donations with status, amount, provider, and SE alert status.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Cashfree 401 error | Check `CASHFREE_SANDBOX_APP_ID` / `CASHFREE_APP_ID` are set correctly for your mode |
| Stripe checkout session fails | Check `STRIPE_SECRET_KEY` / `STRIPE_TEST_SECRET_KEY` are set correctly for your mode |
| SE alert not firing | Check `SE_CHANNEL_ID` and `SE_JWT_TOKEN` are correct |
| Payment stuck on pending | Check Vercel function logs under **Deployments → Functions** |
| YouTube chat not posting | Make sure CG Live app is open and you have an active live broadcast |
| `Invalid vercel.json` | Make sure you haven't added `"env"` block inside vercel.json — set env vars in Vercel dashboard only |
| Widget not showing in OBS | Check OBS browser source URL matches your SE overlay URL exactly |

---

## Notes

- Minimum tip amount: ₹1
- PayPal transactions are in USD
- SE widget auto-hides after 8 seconds
- Silent tips (no message) are not shown on the widget but still logged
- All donations are logged in Supabase regardless of SE/YT chat status