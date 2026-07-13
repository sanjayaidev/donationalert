# Audio System Integration Guide

## Overview
This guide explains how to integrate the OBS Audio Player with your donation system to play sounds when someone donates.

## Files Created

### 1. `/obs-audio.html` - OBS Browser Source Page
A dedicated page that can be loaded as a Browser Source in OBS, Streamlabs, or any streaming software.

**Features:**
- Plays audio from URL parameters: `?play=donation` or `?url=https://example.com/sound.mp3`
- Receives commands via `postMessage` API
- Visual audio visualizer
- OBS mode (hides UI elements, shows only visualizer)
- Cache-busting for reliable playback
- Auto-resumes audio context on user interaction

### 2. `/public/sounds/` - Sound Files Directory
Place your custom sound files here:
- `donation.mp3` - Default donation sound
- `alert.mp3` - Alert notification
- `notification.mp3` - General notification
- `cheer.mp3` - Cheer/sub celebration
- `sub.mp3` - Subscription sound

## Setup Instructions

### Step 1: Add Sound Files
Download or create MP3 files and place them in `/public/sounds/`:
```bash
# Example structure
/public/sounds/
├── donation.mp3
├── alert.mp3
├── notification.mp3
└── cheer.mp3
```

### Step 2: Configure OBS Browser Source

**Option A: Simple URL Trigger**
1. Add Browser Source in OBS
2. URL: `https://yourapp.vercel.app/obs-audio.html?obs=true`
3. Width: 800, Height: 600
4. Check "Control audio via OBS"

**Option B: With Auto-play**
1. Add Browser Source in OBS
2. URL: `https://yourapp.vercel.app/obs-audio.html?obs=true&play=donation`
3. This will play the donation sound immediately on load

### Step 3: Control Audio from Your App

#### Method 1: PostMessage API (Recommended)
```javascript
// Get reference to the browser source iframe or window
const obsWindow = window.open('https://yourapp.vercel.app/obs-audio.html', 'obsAudio');

// Send play command
obsWindow.postMessage({
  action: 'playSound',
  url: 'https://yourapp.vercel.app/sounds/donation.mp3',
  donorName: 'John Doe',
  amount: '₹500'
}, '*');
```

#### Method 2: Custom Event (Same Tab)
```javascript
// Dispatch event if obs-audio.html is in same tab/window
window.dispatchEvent(new CustomEvent('playDonationSound', {
  detail: {
    url: '/sounds/donation.mp3',
    donorName: 'Jane Smith',
    amount: '₹1000'
  }
}));
```

#### Method 3: URL Parameter (New Window/Tab)
```javascript
// Open new window with sound to play
window.open(
  `https://yourapp.vercel.app/obs-audio.html?obs=true&url=${encodeURIComponent(soundUrl)}`,
  'obsAudio',
  'width=800,height=600'
);
```

## Integration with Donation Flow

### Update donate.js to Play Sound

Add this code to the `handleSubmit` function in `donate.js` after successful payment:

```javascript
// After payment success in payment.html or callback
function playDonationSound(donorName, amount, soundUrl) {
  // Method 1: If you have obs-audio.html loaded in an iframe
  const obsFrame = document.getElementById('obsAudioFrame');
  if (obsFrame && obsFrame.contentWindow) {
    obsFrame.contentWindow.postMessage({
      action: 'playSound',
      url: soundUrl || '/sounds/donation.mp3',
      donorName: donorName,
      amount: amount
    }, '*');
  }
  
  // Method 2: Open in new window (for testing)
  // window.open(
  //   `https://yourapp.vercel.app/obs-audio.html?obs=true&url=${encodeURIComponent(soundUrl)}`,
  //   'obsAudio',
  //   'width=800,height=600'
  // );
}
```

### Example: Payment Success Handler
In your payment success callback (e.g., in `payment.html` or Razorpay callback):

```javascript
// On successful donation
razorpay.options.handler = function(response) {
  const donationData = JSON.parse(sessionStorage.getItem('donationData'));
  
  // Send to your backend
  fetch('/api/verify-order', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature,
      ...donationData
    })
  })
  .then(res => res.json())
  .then(data => {
    // Play sound!
    const soundUrl = '/sounds/donation.mp3';
    
    // If you have OBS audio player loaded
    window.dispatchEvent(new CustomEvent('playDonationSound', {
      detail: {
        url: soundUrl,
        donorName: donationData.name,
        amount: `₹${donationData.amount}`
      }
    }));
    
    // Redirect to thank you page
    window.location.href = '/thankyou.html';
  });
};
```

## Advanced Usage

### Multiple Sound Types
Configure different sounds for different donation amounts:

```javascript
function getSoundForAmount(amount) {
  if (amount >= 1000) return '/sounds/cheer.mp3';
  if (amount >= 500) return '/sounds/donation.mp3';
  return '/sounds/notification.mp3';
}

// Usage
const soundUrl = getSoundForAmount(donationAmount);
```

### Remote Control from Another Device
Create a simple control panel that sends commands to the OBS audio player:

```javascript
// Control panel script
function triggerSound(soundName) {
  fetch('https://yourapp.vercel.app/api/trigger-sound', {
    method: 'POST',
    body: JSON.stringify({ sound: soundName })
  });
}
```

### WebSocket Control (Real-time)
For real-time control across multiple devices:

```javascript
// In obs-audio.html, add WebSocket listener
const ws = new WebSocket('wss://your-websocket-server.com');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'play') {
    playAudioFromUrl(data.url, data.donorName, data.amount);
  }
};
```

## Troubleshooting

### Audio Doesn't Play
1. **Autoplay Policy**: Browser requires user interaction before autoplay. Click anywhere on the page once to enable audio.
2. **OBS Settings**: Make sure "Control audio via OBS" is checked in Browser Source settings.
3. **File Path**: Verify sound files exist at the specified URLs.

### Sound is Delayed
1. **Preload Audio**: Add `<link rel="preload" as="audio" href="/sounds/donation.mp3">` to preload sounds.
2. **Cache Busting**: The system automatically adds cache-busting parameters.

### Visual Not Showing in OBS
1. **OBS Mode**: Add `?obs=true` to URL to enable OBS mode.
2. **CSS Refresh**: Hard refresh the browser source in OBS (Ctrl+F5).
3. **Dimensions**: Ensure Browser Source dimensions match the content (800x600 recommended).

## API Reference

### PostMessage API
Send messages to the audio player:

```javascript
frame.contentWindow.postMessage({
  action: 'playSound',      // Required: 'playSound' or 'setObsMode'
  url: string,              // Audio file URL
  sound: string,            // Or use preset name: 'donation', 'alert', etc.
  donorName: string,        // Optional: Donor name for display
  amount: string            // Optional: Donation amount for display
}, '*');
```

### Global Functions
Access these from browser console or scripts:

```javascript
// Play sound from URL
window.playDonationSound(url, donorName, amount);

// Play preset sound
window.playSoundByName('donation', donorName, amount);
```

### URL Parameters
- `?play=soundname` - Auto-play preset sound on load
- `?url=https://...` - Auto-play from URL on load
- `?obs=true` - Enable OBS mode (hide UI)
- `?play=soundname&obs=true` - Combine parameters

## Testing

### Test Locally
```bash
# Open obs-audio.html in browser
open http://localhost:3000/obs-audio.html

# Test with URL parameter
open http://localhost:3000/obs-audio.html?play=donation

# Test OBS mode
open http://localhost:3000/obs-audio.html?obs=true
```

### Test PostMessage
Open browser console and run:
```javascript
window.postMessage({
  action: 'playSound',
  url: '/sounds/donation.mp3',
  donorName: 'Test User',
  amount: '₹100'
}, '*');
```

## Deployment

1. **Deploy to Vercel**: All files are ready for Vercel deployment
2. **Add Sound Files**: Upload your MP3 files to `/public/sounds/`
3. **Environment Variables**: No additional env vars needed for audio system
4. **Test**: Verify audio plays correctly in production

## Security Notes

- Validate origins in production when using postMessage
- Host sound files on your own domain for reliability
- Consider adding authentication for remote control APIs
- Use HTTPS for all audio URLs to avoid mixed content warnings
