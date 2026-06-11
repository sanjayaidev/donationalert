# StreamElements Tip Message Widget

A custom StreamElements widget that displays donor name, amount and message on stream when a tip is received via Cashfree → Vercel → StreamElements.

---

## Setup

1. Go to **StreamElements Dashboard → Overlays → Editor**
2. Add a **Custom Widget**
3. Paste the code below into the respective tabs
4. Add as a **Browser Source** in OBS pointing to your SE overlay URL

---

## HTML

```html
<div id="wrap" style="display:none">
  <div id="name"></div>
  <div id="amount"></div>
  <div id="message"></div>
</div>
```

---

## CSS

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

---

## JS

```js
window.addEventListener('onEventReceived', function(obj) {
  const listener = obj.detail.listener;
  const event    = obj.detail.event;

  if (listener !== 'tip-latest') return;

  const name    = event.name    || event.username || 'Anonymous';
  const amount  = event.amount  || 0;
  const message = event.message || '';

  // don't show if tip has no message
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

---

## Fields

```json
{}
```

No fields needed — widget has no configurable options.

---

## How It Works

```
Cashfree payment → Vercel verify-order.js → StreamElements Tip API
                                                      ↓
                                          onEventReceived fires
                                                      ↓
                                          Widget displays message
                                                      ↓
                                          Auto hides after 8 seconds
```

---

## Notes

| Topic | Detail |
|---|---|
| Listener key | `obj.detail.listener` — not `obj.detail.event.listener` |
| Message field | `event.message` directly on the event object |
| Silent tips | Widget stays hidden if no message is included |
| Auto hide | Disappears after 8 seconds |
| Multiple tips | Each new tip resets the 8s timer |

---

## Debugging

Open the overlay URL in a browser, open DevTools console and fire a test tip. The raw SE event structure will be logged:

```js
console.log('SE event:', JSON.stringify(obj.detail));
```
## Test Console Command
fetch('/api/test-se', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'your-password-here' })
}).then(r => r.json()).then(console.log)


Common failure reasons:
- `listener !== 'tip-latest'` — wrong listener string, check console log
- `event.message` is empty — tip was sent without a message
- Widget not showing — check OBS browser source URL is correct SE overlay URL
