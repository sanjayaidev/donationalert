/**
 * StreamTip Donate Button & Popup Widget
 * Self-contained support button with animated gradient
 * Opens text-only donation popup (no tiers, no rewards)
 */
(function(){
  'use strict';

  // ===== CONFIGURATION =====
  const CONFIG = {
    streamerName: 'CHAMP GAMING',
    streamerDesc: 'Champ Support',
    logoUrl: '/CGLive.png', // Path to logo image in same directory as index.html
    currency: { code: 'INR', symbol: '₹' },
    messageTypes: [
      { id: 'text', label: 'TEXT', sublabel: 'Chat message on stream', color: '#22d3ee', minAmount: 1 }
    ],
    labels: {
      nameField: 'YOUR NAME',
      namePlaceholder: 'Enter your name',
      amountField: 'AMOUNT',
      messageField: 'MESSAGE',
      messagePlaceholder: 'Your message (optional)',
      support: 'SUPPORT'
    },
    messageMaxLength: 70,
    suggestedAmounts: [10, 29, 49, 100, 200]
  };

  // ===== STYLES =====
  const styles = `
    :root {
      --st-bg: #050507;
      --st-surface: #0a0a11;
      --st-surface2: #0f0f18;
      --st-surface3: #151521;
      --st-border: #1c1c2a;
      --st-border2: #25253a;
      --st-text: #eef0fb;
      --st-text2: #8c8caa;
      --st-text3: #4d4d66;
      --st-cyan: #22d3ee;
      --st-amber: #ffb020;
      --st-violet: #a855f7;
      --st-red: #ff3f66;
      --st-font-head: 'Syne', sans-serif;
      --st-font-mono: 'JetBrains Mono', monospace;
    }

    /* Support Button */
    .st-support-btn {
      position: fixed;
      right: 26px;
      bottom: 26px;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 15px 22px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      font-family: var(--st-font-mono);
      font-weight: 700;
      font-size: 13px;
      letter-spacing: .03em;
      color: #04070a;
      background: linear-gradient(100deg, var(--st-cyan), var(--st-violet) 45%, var(--st-amber) 85%);
      background-size: 220% 100%;
      box-shadow: 0 8px 30px rgba(168,85,247,.35), 0 0 0 1px rgba(255,255,255,.08) inset;
      animation: stTriggerPulse 2.6s ease-in-out infinite, stSheenSlide 3.4s linear infinite;
    }
    .st-support-btn:hover { filter: brightness(1.08); }
    @keyframes stTriggerPulse {
      0%,100% { box-shadow: 0 8px 30px rgba(168,85,247,.35), 0 0 0 1px rgba(255,255,255,.08) inset; }
      50% { box-shadow: 0 8px 44px rgba(34,211,238,.55), 0 0 0 1px rgba(255,255,255,.12) inset; }
    }
    @keyframes stSheenSlide {
      0% { background-position: 0% 50%; }
      100% { background-position: 200% 50%; }
    }

    /* Overlay */
    .st-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(3,3,6,.72);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      opacity: 0;
      pointer-events: none;
      transition: opacity .28s ease;
    }
    .st-overlay.open { opacity: 1; pointer-events: auto; }

    /* Modal */
    .st-modal {
      position: relative;
      width: 100%;
      max-width: 420px;
      max-height: 92vh;
      overflow-y: auto;
      background: linear-gradient(180deg, var(--st-surface), var(--st-surface2) 60%);
      border-radius: 22px;
      border: 1px solid var(--st-border2);
      padding: 2px;
      transform: translateY(28px) scale(.96);
      opacity: 0;
      transition: transform .34s cubic-bezier(.2,.9,.25,1.15), opacity .3s ease;
    }
    .st-overlay.open .st-modal {
      transform: translateY(0) scale(1);
      opacity: 1;
    }
    .st-modal::-webkit-scrollbar { width: 6px; }
    .st-modal::-webkit-scrollbar-thumb { background: var(--st-border2); border-radius: 6px; }

    /* Modal glow */
    .st-modal-glow {
      position: absolute;
      inset: -2px;
      border-radius: 24px;
      z-index: -1;
      background: conic-gradient(from 0deg, var(--st-cyan), var(--st-violet), var(--st-amber), var(--st-cyan));
      filter: blur(14px);
      opacity: .35;
      animation: stSpin 8s linear infinite;
    }
    @keyframes stSpin { to { transform: rotate(360deg); } }

    .st-modal-inner {
      position: relative;
      padding: 22px;
      border-radius: 20px;
      background: var(--st-surface);
    }

    /* Close button */
    .st-close-btn {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 30px;
      height: 30px;
      border-radius: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--st-surface3);
      border: 1px solid var(--st-border2);
      color: var(--st-text2);
      cursor: pointer;
      font-size: 15px;
      transition: .15s;
    }
    .st-close-btn:hover { color: var(--st-text); border-color: var(--st-red); }

    /* Header */
    .st-stream-head {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 20px;
    }
    .st-avatar-wrap {
      position: relative;
      width: 56px;
      height: 56px;
      flex-shrink: 0;
    }
    .st-avatar-ring {
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      background: conic-gradient(var(--st-cyan), var(--st-violet), var(--st-amber), var(--st-cyan));
      animation: stSpin 5s linear infinite;
    }
    .st-avatar {
      position: absolute;
      inset: 2px;
      border-radius: 50%;
      background: var(--st-surface3);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--st-font-head);
      font-weight: 800;
      font-size: 18px;
      color: var(--st-text);
      overflow: hidden;
    }
    .st-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .st-stream-name {
      font-family: var(--st-font-head);
      font-weight: 800;
      font-size: 19px;
      letter-spacing: -.02em;
      line-height: 1.15;
    }
    .st-stream-desc {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-top: 5px;
      font-size: 10px;
      letter-spacing: .06em;
      color: var(--st-cyan);
      background: rgba(34,211,238,.08);
      border: 1px solid rgba(34,211,238,.28);
      padding: 3px 9px;
      border-radius: 999px;
      font-weight: 600;
    }

    /* Fields */
    .st-field { margin-bottom: 18px; }
    .st-field-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .09em;
      color: var(--st-text3);
      margin-bottom: 8px;
    }
    .st-text-input, .st-textarea {
      width: 100%;
      background: var(--st-surface3);
      border: 1px solid var(--st-border2);
      border-radius: 11px;
      padding: 12px 14px;
      color: var(--st-text);
      font-family: var(--st-font-mono);
      font-size: 13px;
      outline: none;
      transition: .15s;
    }
    .st-text-input:focus, .st-textarea:focus {
      border-color: var(--st-cyan);
      box-shadow: 0 0 0 3px rgba(34,211,238,.12);
    }
    .st-textarea { resize: none; min-height: 70px; line-height: 1.5; }

    /* Amount row */
    .st-amount-row { display: flex; gap: 8px; }
    .st-currency-box {
      flex-shrink: 0;
      width: 66px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--st-surface3);
      border: 1px solid var(--st-border2);
      border-radius: 11px;
      font-size: 13px;
      font-weight: 700;
      color: var(--st-text2);
    }
    .st-chips { display: flex; gap: 7px; margin-top: 9px; flex-wrap: wrap; }
    .st-chip {
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: var(--st-surface3);
      border: 1px solid var(--st-border2);
      color: var(--st-text2);
      cursor: pointer;
      transition: .15s;
    }
    .st-chip:hover { border-color: var(--st-cyan); color: var(--st-text); }

    /* Submit button */
    .st-submit-btn {
      width: 100%;
      border: none;
      border-radius: 13px;
      padding: 15px;
      cursor: pointer;
      font-family: var(--st-font-mono);
      font-weight: 800;
      font-size: 14px;
      letter-spacing: .03em;
      color: #04070a;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: linear-gradient(100deg, var(--st-cyan), var(--st-violet) 50%, var(--st-amber) 100%);
      background-size: 220% 100%;
      box-shadow: 0 10px 26px -6px var(--st-cyan);
      transition: box-shadow .2s, filter .2s;
      animation: stSheenSlide 3s linear infinite;
    }
    .st-submit-btn:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; animation-play-state: paused; }
    .st-submit-btn:not(:disabled):hover { filter: brightness(1.08); }

    .st-footer-note {
      text-align: center;
      font-size: 9.5px;
      color: var(--st-text3);
      margin-top: 16px;
      line-height: 1.6;
    }

    /* Message counter */
    .st-msg-counter {
      font-size: 9px;
      color: var(--st-text3);
      font-weight: 600;
    }
  `;

  // ===== HTML STRUCTURE =====
  const html = `
    <button class="st-support-btn" id="stOpenBtn">
      <i style="font-style:normal;">❤️</i> <span>SUPPORT THE STREAM</span>
    </button>

    <div class="st-overlay" id="stOverlay">
      <div class="st-modal">
        <div class="st-modal-glow"></div>
        <div class="st-modal-inner">
          <button class="st-close-btn" id="stCloseBtn">×</button>

          <div class="st-stream-head">
            <div class="st-avatar-wrap">
              <div class="st-avatar-ring"></div>
              <div class="st-avatar" id="stAvatar">
                <img id="stAvatarImg" src="" alt="" style="display:none;">
                <span id="stAvatarText">?</span>
              </div>
            </div>
            <div>
              <div class="st-stream-name" id="stStreamerName">STREAMER</div>
              <div class="st-stream-desc"><i style="margin-right:4px;">●</i> LIVE</div>
            </div>
          </div>

          <div class="st-field">
            <div class="st-field-label" id="stNameLabel">YOUR NAME</div>
            <input class="st-text-input" id="stDonorName" type="text" placeholder="Enter your name">
          </div>

          <div class="st-field">
            <div class="st-field-label">EMAIL (for receipt)</div>
            <input class="st-text-input" id="stDonorEmail" type="email" placeholder="you@example.com">
          </div>

          <div class="st-field">
            <div class="st-field-label" id="stAmountLabel">AMOUNT</div>
            <div class="st-amount-row">
              <div class="st-currency-box" id="stCurrencyBox">₹ INR</div>
              <input class="st-text-input" id="stAmountInput" type="number" min="1" placeholder="0" style="flex:1;">
            </div>
            <div class="st-chips" id="stChips"></div>
          </div>

          <div class="st-field">
            <div class="st-field-label">
              <span id="stMessageLabel">MESSAGE</span>
              <span class="st-msg-counter" id="stMsgCounter">0/70</span>
            </div>
            <textarea class="st-textarea" id="stMessageInput" placeholder="Your message (optional)"></textarea>
          </div>

          <button class="st-submit-btn" id="stSubmitBtn" disabled>
            <i style="font-style:normal;">❤️</i> <span id="stSubmitLabel">SUPPORT ₹0</span>
          </button>

          <div class="st-footer-note">
            This is a secure tip payment.<br>
            You'll be redirected to complete payment.
          </div>
        </div>
      </div>
    </div>
  `;

  // ===== INITIALIZATION =====
  function init() {
    // Inject styles
    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);

    // Inject HTML
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    // Load fonts if not already loaded
    if (!document.querySelector('link[href*="fonts.googleapis.com"]')) {
      const link1 = document.createElement('link');
      link1.rel = 'preconnect';
      link1.href = 'https://fonts.googleapis.com';
      document.head.appendChild(link1);

      const link2 = document.createElement('link');
      link2.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&family=Syne:wght@600;700;800&display=swap';
      link2.rel = 'stylesheet';
      document.head.appendChild(link2);
    }

    // Initialize UI
    const cfg = CONFIG;
    document.getElementById('stStreamerName').textContent = cfg.streamerName;
    
    // Handle logo: show image if URL provided, otherwise show initial
    const avatarImg = document.getElementById('stAvatarImg');
    const avatarText = document.getElementById('stAvatarText');
    if (cfg.logoUrl && cfg.logoUrl.trim() !== '') {
      avatarImg.src = cfg.logoUrl;
      avatarImg.style.display = 'block';
      avatarText.style.display = 'none';
    } else {
      avatarText.textContent = cfg.streamerName.charAt(0).toUpperCase();
    }
    
    document.getElementById('stNameLabel').textContent = cfg.labels.nameField;
    document.getElementById('stDonorName').placeholder = cfg.labels.namePlaceholder;
    document.getElementById('stAmountLabel').textContent = cfg.labels.amountField;
    document.getElementById('stMessageLabel').textContent = cfg.labels.messageField;
    document.getElementById('stMessageInput').placeholder = cfg.labels.messagePlaceholder;
    document.getElementById('stCurrencyBox').textContent = `${cfg.currency.symbol} ${cfg.currency.code}`;
    document.getElementById('stMsgCounter').textContent = `0/${cfg.messageMaxLength}`;
    document.getElementById('stMessageInput').maxLength = cfg.messageMaxLength;

    // Render chips
    renderChips();

    // Bind events
    bindEvents();

    // Initial update
    updateAll();
  }

  function renderChips() {
    const wrap = document.getElementById('stChips');
    wrap.innerHTML = '';
    CONFIG.suggestedAmounts.forEach(v => {
      const chip = document.createElement('div');
      chip.className = 'st-chip';
      chip.textContent = `${CONFIG.currency.symbol}${v}`;
      chip.addEventListener('click', () => {
        document.getElementById('stAmountInput').value = v;
        updateAll();
      });
      wrap.appendChild(chip);
    });
  }

  function bindEvents() {
    const overlay = document.getElementById('stOverlay');

    document.getElementById('stOpenBtn').addEventListener('click', () => {
      overlay.classList.add('open');
    });

    document.getElementById('stCloseBtn').addEventListener('click', () => {
      overlay.classList.remove('open');
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('open');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        overlay.classList.remove('open');
      }
    });

    document.getElementById('stAmountInput').addEventListener('input', updateAll);

    document.getElementById('stMessageInput').addEventListener('input', () => {
      const input = document.getElementById('stMessageInput');
      document.getElementById('stMsgCounter').textContent = `${input.value.length}/${CONFIG.messageMaxLength}`;
    });

    document.getElementById('stSubmitBtn').addEventListener('click', handleSubmit);
  }

  function updateAll() {
    const amount = parseFloat(document.getElementById('stAmountInput').value) || 0;
    const btn = document.getElementById('stSubmitBtn');
    const canSubmit = amount >= 1;
    btn.disabled = !canSubmit;
    document.getElementById('stSubmitLabel').textContent =
      canSubmit ? `${CONFIG.labels.support} ${CONFIG.currency.symbol}${amount}` : `${CONFIG.labels.support} ${CONFIG.currency.symbol}0`;
  }

  function handleSubmit() {
    const amount = parseFloat(document.getElementById('stAmountInput').value) || 0;
    const name = document.getElementById('stDonorName').value.trim();
    const email = document.getElementById('stDonorEmail').value.trim();
    const message = document.getElementById('stMessageInput').value.trim();

    if (!name) {
      alert('Please enter your name');
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert('Please enter a valid email address');
      return;
    }
    if (!amount || amount < 1) {
      alert('Please choose an amount of at least ' + CONFIG.currency.symbol + '1');
      return;
    }

    const payload = {
      name,
      email,
      amount,
      message,
      type: 'text',
      typeLabel: 'TEXT',
      currencySymbol: CONFIG.currency.symbol,
      currencyCode: CONFIG.currency.code,
      source: 'popup'
    };

    try {
      sessionStorage.setItem('donationData', JSON.stringify(payload));
    } catch (e) {
      console.warn('SessionStorage error:', e);
    }

    // Redirect to payment page
    window.location.href = 'payment.html';
  }

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
