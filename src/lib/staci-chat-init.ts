/* Staci Chat — full initialization module.
   Dynamically imported after browser idle to keep 16 KB out of the critical path. */

const STORAGE_KEY = 'staci_chat_history';
const STORAGE_PANEL_KEY = 'staci_panel_open';
const STORAGE_SESSION_KEY = 'staci_session_id';
const STORAGE_VERSION = 'v2';
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_STORED_MESSAGES = 50;
const AVATAR_URL = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/ai-chat-avatar/w=60,h=60,fit=cover,format=auto';

let conversationHistory: { role: string; content: string }[] = [];
let isSending = false;
let _streamRAF = 0;

// ─── Session ID (cross-session memory) ──────────────────────
function getSessionId(): string {
  let id = localStorage.getItem(STORAGE_SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_SESSION_KEY, id);
  }
  return id;
}

function resetSessionId(): void {
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_SESSION_KEY, id);
}

// ─── Helpers ─────────────────────────────────────────────

function escapeHtml(str: string) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Escape a string for use inside an HTML attribute (href, src) */
function escapeAttr(str: string) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Shared inline markdown transforms: code, bold, italic, links, lists */
function applyInlineMarkdown(html: string): string {
  // Inline code: `text`
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic: *text* (but not inside links/bold)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Links: all open in new tab so chat stays open while browsing
  // Only allow http(s) and relative URLs — block javascript: and data: schemes
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_match, linkText, url) => {
    const safeUrl = /^(https?:\/\/|\/[^\/])/.test(url) ? url : '#';
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
  });

  return html;
}

/** Convert markdown list blocks to HTML <ul>/<ol> */
function applyListMarkdown(html: string): string {
  // Process unordered lists (lines starting with - or *)
  html = html.replace(/((?:^|\n)(?:[*\-] .+(?:\n|$))+)/g, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^[*\-]\s+/, '')}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  // Process ordered lists (lines starting with 1. 2. etc)
  html = html.replace(/((?:^|\n)(?:\d+\.\s+.+(?:\n|$))+)/g, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^\d+\.\s+/, '')}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  return html;
}

/** Markdown → HTML with paragraph wrapping on double newlines */
function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Split on double newlines FIRST (before list processing eats them)
  const blocks = html.split(/\n{2,}/);

  if (blocks.length > 1) {
    html = blocks
      .map(b => b.trim())
      .filter(b => b.length > 0)
      .map(b => {
        b = applyInlineMarkdown(b);
        b = applyListMarkdown(b);
        // If block became a list, don't wrap in <p>
        const stripped = b.trim();
        if (stripped.startsWith('<ul>') || stripped.startsWith('<ol>')) return stripped;
        // Convert remaining single newlines to <br>
        return `<p>${stripped.replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  } else {
    html = applyInlineMarkdown(html);
    html = applyListMarkdown(html);
    html = html.replace(/\n/g, '<br>');
  }

  // Clean up stray <br> adjacent to lists
  html = html.replace(/<br><(ul|ol)>/g, '<$1>');
  html = html.replace(/<\/(ul|ol)><br>/g, '</$1>');
  html = html.replace(/<p><br>/g, '<p>');
  html = html.replace(/<br><\/p>/g, '</p>');

  return html;
}

/** Streaming-safe markdown: no paragraph wrapping (avoids reflow mid-stream),
 *  strip trailing incomplete markers to prevent flicker */
function renderStreamingMarkdown(text: string): string {
  const cleaned = text.replace(/\*+$/, '').replace(/`$/, '').replace(/\[$/, '').replace(/\]\([^)]*$/, '');
  let html = escapeHtml(cleaned);

  html = applyInlineMarkdown(html);
  html = applyListMarkdown(html);

  // All newlines → <br> (no paragraph wrapping during streaming to avoid reflow)
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<br><(ul|ol)>/g, '<$1>');
  html = html.replace(/<\/(ul|ol)><br>/g, '</$1>');

  return html;
}

// ─── Session Storage ───────────────────────────────────────

function saveSession() {
  try {
    const data = {
      v: STORAGE_VERSION,
      messages: conversationHistory.slice(-MAX_STORED_MESSAGES),
      expires: Date.now() + STORAGE_TTL_MS,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* quota exceeded — ignore */ }
}

function loadSession(): { role: string; content: string }[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    // Version mismatch or expired — clear
    if (data.v !== STORAGE_VERSION) { localStorage.removeItem(STORAGE_KEY); return []; }
    if (data.expires && Date.now() > data.expires) { localStorage.removeItem(STORAGE_KEY); return []; }
    return data.messages || [];
  } catch {
    return [];
  }
}

function restoreSession() {
  const saved = loadSession();
  if (saved.length) {
    conversationHistory = saved;
    const messagesEl = document.getElementById('staci-messages');
    if (messagesEl) {
      messagesEl.innerHTML = '';
      saved.forEach(msg => {
        if (msg.role === 'user') addUserBubble(msg.content, false);
        else addBotBubble(msg.content, false);
      });
      if (saved.length > 0) hideChips();
    }
  }

  // Re-open panel if it was open before navigation
  if (localStorage.getItem(STORAGE_PANEL_KEY) === 'true') {
    openPanel();
  }
}

// ─── Send Lock ──────────────────────────────────────────────

function lockSend() {
  isSending = true;
  const btn = document.getElementById('staci-send') as HTMLButtonElement | null;
  const input = document.getElementById('staci-input') as HTMLTextAreaElement | null;
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;
}

function unlockSend() {
  isSending = false;
  const btn = document.getElementById('staci-send') as HTMLButtonElement | null;
  const input = document.getElementById('staci-input') as HTMLTextAreaElement | null;
  if (input) {
    input.disabled = false;
    input.focus();
    if (btn) btn.disabled = input.value.trim().length === 0;
  }
}

// ─── Unread Badge ──────────────────────────────────────────

function showBadge() {
  const badge = document.getElementById('staci-badge');
  if (badge) badge.style.display = 'block';
}

function hideBadge() {
  const badge = document.getElementById('staci-badge');
  if (badge) badge.style.display = 'none';
}

// ─── Welcome Card ──────────────────────────────────────────

function welcomeCardHTML(): string {
  return `<div class="staci-welcome" id="staci-welcome">
    <img class="staci-welcome__avatar" src="https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/ai-chat-avatar/w=128,h=128,fit=cover,format=auto" alt="Staci" width="56" height="56" />
    <p class="staci-welcome__name">Hi, I'm Staci</p>
    <p class="staci-welcome__sub">Your personal shopping assistant.<br>How can I help you today?</p>
    <div class="staci-welcome__chips">
      <button class="staci-chip" data-msg="What's new in the shop?">What's new?</button>
      <button class="staci-chip" data-msg="What are your store hours and location?">Hours &amp; location</button>
      <button class="staci-chip" data-msg="What is your return policy?">Return policy</button>
      <button class="staci-chip" data-msg="Tell me about Sunny &amp; Ranney's mission">Your mission</button>
    </div>
  </div>`;
}

// ─── DOM Manipulation ─────────────────────────────────────

let _lastMsgTs = 0;
const TIME_GAP_MS = 2 * 60 * 1000; // 2 minutes

let _isStreaming = false;

function scrollToBottom() {
  const messagesEl = document.getElementById('staci-messages');
  if (!messagesEl) return;
  // During streaming, use instant scroll to avoid jank from competing smooth scrolls
  if (_isStreaming) {
    messagesEl.style.scrollBehavior = 'auto';
    messagesEl.scrollTop = messagesEl.scrollHeight;
    messagesEl.style.scrollBehavior = '';
  } else {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

/** Insert a time separator if enough time has elapsed since the last message */
function maybeAddTimeSep(messagesEl: HTMLElement, animate: boolean) {
  const now = Date.now();
  if (_lastMsgTs && (now - _lastMsgTs > TIME_GAP_MS)) {
    const sep = document.createElement('div');
    sep.className = 'staci-time-sep';
    if (!animate) sep.style.animation = 'none';
    sep.textContent = timeAgo(_lastMsgTs);
    messagesEl.appendChild(sep);
  }
  _lastMsgTs = now;
}

function addUserBubble(text: string, animate = true) {
  const messagesEl = document.getElementById('staci-messages');
  if (!messagesEl) return;
  if (animate) maybeAddTimeSep(messagesEl, animate);
  const msg = document.createElement('div');
  msg.className = `staci-msg staci-msg--user`;
  if (animate) msg.dataset.ts = String(Date.now());
  if (!animate) msg.style.animation = 'none';
  msg.innerHTML = `
    <span class="staci-msg__avatar"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0 2c-3.33 0-10 1.67-10 5v2h20v-2c0-3.33-6.67-5-10-5z"/></svg></span>
    <div class="staci-msg__body">
      <div class="staci-msg__bubble">${escapeHtml(text)}</div>
      ${animate ? '<span class="staci-msg__delivered"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Sent</span>' : ''}
      <time class="staci-msg__time">just now</time>
    </div>
  `;
  messagesEl.appendChild(msg);
  scrollToBottom();
}

function addBotBubble(text: string, animate = true): HTMLElement {
  const messagesEl = document.getElementById('staci-messages');
  const msg = document.createElement('div');
  msg.className = `staci-msg staci-msg--bot`;
  if (animate) msg.dataset.ts = String(Date.now());
  if (!animate) msg.style.animation = 'none';
  msg.innerHTML = `
    <img class="staci-msg__avatar" src="${AVATAR_URL}" loading="lazy" alt="Staci" width="30" height="30" />
    <div class="staci-msg__body">
      <div class="staci-msg__bubble">${renderMarkdown(text)}</div>
      <time class="staci-msg__time">just now</time>
    </div>
  `;
  if (messagesEl) {
    messagesEl.appendChild(msg);
    scrollToBottom();
  }
  return msg;
}

/** Create a bot bubble for streaming — returns the bubble element to update */
function addStreamingBubble(): { container: HTMLElement; bubble: HTMLElement } {
  const messagesEl = document.getElementById('staci-messages');
  const msg = document.createElement('div');
  msg.className = 'staci-msg staci-msg--bot staci-msg--stream-start';
  msg.dataset.ts = String(Date.now());

  const avatar = document.createElement('img');
  avatar.className = 'staci-msg__avatar';
  avatar.src = AVATAR_URL;
  avatar.alt = 'Staci';
  avatar.loading = 'lazy';
  avatar.width = 26;
  avatar.height = 26;

  const body = document.createElement('div');
  body.className = 'staci-msg__body';

  const bubble = document.createElement('div');
  bubble.className = 'staci-msg__bubble staci-streaming';

  const time = document.createElement('time');
  time.className = 'staci-msg__time';
  time.textContent = 'just now';

  body.appendChild(bubble);
  body.appendChild(time);
  msg.appendChild(avatar);
  msg.appendChild(body);

  if (messagesEl) {
    messagesEl.appendChild(msg);
    scrollToBottom();
  }
  return { container: msg, bubble };
}

function addErrorBubble(errorText: string, retryFn: () => void) {
  const messagesEl = document.getElementById('staci-messages');
  if (!messagesEl) return;
  const msg = document.createElement('div');
  msg.className = 'staci-msg staci-msg--bot staci-msg--error';
  msg.dataset.ts = String(Date.now());

  const avatar = document.createElement('img');
  avatar.className = 'staci-msg__avatar';
  avatar.src = AVATAR_URL;
  avatar.alt = 'Staci';
  avatar.loading = 'lazy';
  avatar.width = 26;
  avatar.height = 26;
  msg.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'staci-msg__body';

  const bubble = document.createElement('div');
  bubble.className = 'staci-msg__bubble';
  bubble.textContent = errorText + ' ';
  const retry = document.createElement('button');
  retry.className = 'staci-retry';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => {
    msg.remove();
    retryFn();
  });
  bubble.appendChild(retry);

  const time = document.createElement('time');
  time.className = 'staci-msg__time';
  time.textContent = 'just now';

  body.appendChild(bubble);
  body.appendChild(time);
  msg.appendChild(body);

  messagesEl.appendChild(msg);
  scrollToBottom();
}

function getTypingLabel(): string {
  const lastUser = conversationHistory.slice().reverse().find(m => m.role === 'user');
  if (!lastUser) return 'Staci is thinking...';
  const text = lastUser.content.toLowerCase();
  if (/table|chair|sofa|couch|bed|desk|rug|lamp|mirror|art/.test(text)) return 'Searching our catalog...';
  if (/hour|open|close|location|address|direction/.test(text)) return 'Looking that up...';
  if (/return|refund|exchange|policy/.test(text)) return 'Checking our policies...';
  return 'Staci is thinking...';
}

function showTyping() {
  const messagesEl = document.getElementById('staci-messages');
  if (!messagesEl) return;
  const typing = document.createElement('div');
  typing.className = 'staci-msg staci-msg--bot staci-typing';
  typing.id = 'staci-typing';
  typing.innerHTML = `
    <img class="staci-msg__avatar" src="${AVATAR_URL}" loading="lazy" alt="Staci" width="30" height="30" />
    <div class="staci-msg__body">
      <div class="staci-msg__bubble">
        <span class="staci-shimmer">
          <span class="staci-shimmer-bar"></span>
          <span class="staci-shimmer-bar"></span>
        </span>
        <span class="staci-typing__label">${getTypingLabel()}</span>
      </div>
    </div>
  `;
  messagesEl.appendChild(typing);
  scrollToBottom();
}

function removeTyping() {
  document.getElementById('staci-typing')?.remove();
}

function hideChips() {
  const chips = document.getElementById('staci-chips');
  if (chips) chips.style.display = 'none';
  // Remove welcome card and inline suggestion pills
  const welcome = document.getElementById('staci-welcome');
  if (welcome) welcome.remove();
  document.querySelectorAll('.staci-suggestions').forEach(el => el.remove());
}

function showChips() {
  const chips = document.getElementById('staci-chips');
  if (chips) chips.style.display = '';
}

/** Parse "?>" follow-up suggestions from bot response and return cleaned text + suggestions.
 *  Also detects question-style follow-ups the LLM writes as plain text at the end of a message. */
function parseSuggestions(text: string): { clean: string; suggestions: string[] } {
  const lines = text.split('\n');
  const suggestions: string[] = [];
  const cleanLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('?>')) {
      const q = trimmed.slice(2).trim();
      if (q) suggestions.push(q);
    } else {
      cleanLines.push(line);
    }
  }

  // If no ?>-prefixed suggestions found, try to detect trailing question lines.
  if (suggestions.length === 0) {
    // Pattern 1: single line with multiple short questions separated by spaces
    const lastNonBlank = cleanLines.slice().reverse().find(l => l.trim().length > 0);
    if (lastNonBlank) {
      // First try double-space split
      let multiQ = lastNonBlank.trim().split(/\s{2,}/).filter(s => s.endsWith('?') && s.length <= 50);
      // If that didn't work, try splitting on "? " to catch single-space separated questions
      if (multiQ.length < 2) {
        const parts = lastNonBlank.trim().split(/\?\s+/);
        multiQ = parts.map((p, i) => i < parts.length - 1 ? p.trim() + '?' : p.trim())
          .filter(s => s.endsWith('?') && s.length <= 50 && s.length >= 5);
      }
      if (multiQ.length >= 2) {
        suggestions.push(...multiQ);
        // Remove that line from clean output
        const idx = cleanLines.lastIndexOf(lastNonBlank);
        if (idx !== -1) cleanLines.splice(idx, 1);
      }
    }

    // Pattern 2: consecutive trailing lines that are each a short question
    if (suggestions.length === 0) {
      const trailing: string[] = [];
      for (let i = cleanLines.length - 1; i >= 0; i--) {
        const t = cleanLines[i].trim();
        if (!t) continue; // skip blank lines
        // Match lines like "What's new?", "- What's new?", "• What's new?"
        const stripped = t.replace(/^[-•*]\s*/, '').replace(/^\d+[.)]\s*/, '');
        if (stripped.endsWith('?') && stripped.length <= 50 && stripped.length >= 8) {
          trailing.unshift(stripped);
        } else {
          break;
        }
      }
      if (trailing.length >= 2) {
        suggestions.push(...trailing);
        // Remove those trailing question lines from clean output
        let removed = 0;
        for (let i = cleanLines.length - 1; i >= 0 && removed < trailing.length; i--) {
          const t = cleanLines[i].trim();
          if (!t) continue;
          cleanLines.splice(i, 1);
          removed++;
        }
      }
    }
  }

  // Remove trailing blank lines from clean text
  const clean = cleanLines.join('\n').replace(/\n+$/, '');
  return { clean, suggestions: suggestions.slice(0, 3) };
}

/** Render follow-up suggestions as inline pills below the last bot message */
function updateChips(suggestions: string[]) {
  if (suggestions.length === 0) return;

  // Remove any existing inline suggestions
  document.querySelectorAll('.staci-suggestions').forEach(el => el.remove());

  const messagesEl = document.getElementById('staci-messages');
  if (!messagesEl) return;

  const row = document.createElement('div');
  row.className = 'staci-suggestions';

  for (const text of suggestions) {
    const btn = document.createElement('button');
    btn.className = 'staci-suggestion-pill';
    btn.dataset.msg = text;
    btn.textContent = text;
    row.appendChild(btn);
  }

  messagesEl.appendChild(row);
  scrollToBottom();

  // Also update the bottom chips bar as a fallback
  const chipsEl = document.getElementById('staci-chips');
  if (chipsEl) {
    chipsEl.innerHTML = '';
    for (const text of suggestions) {
      const btn = document.createElement('button');
      btn.className = 'staci-chip';
      btn.dataset.msg = text;
      btn.textContent = text;
      chipsEl.appendChild(btn);
    }
    chipsEl.style.display = '';
  }
}

// ─── Reset Conversation ────────────────────────────────────

function resetConversation() {
  if (isSending) return;
  conversationHistory = [];
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  resetSessionId();

  const messagesEl = document.getElementById('staci-messages');
  if (messagesEl) {
    messagesEl.innerHTML = '';
    messagesEl.insertAdjacentHTML('beforeend', welcomeCardHTML());
  }
  // Hide bottom chips — welcome card has its own
  const chips = document.getElementById('staci-chips');
  if (chips) chips.style.display = 'none';

  const input = document.getElementById('staci-input') as HTMLTextAreaElement | null;
  const charCount = document.getElementById('staci-char-count');
  if (input) { input.value = ''; input.style.height = 'auto'; input.focus(); }
  if (charCount) { charCount.textContent = ''; charCount.style.display = 'none'; }
}

// ─── Chat Toggle ──────────────────────────────────────────

function openPanel() {
  const panel = document.getElementById('staci-panel');
  const iconChat = document.getElementById('staci-icon-chat');
  const iconClose = document.getElementById('staci-icon-close');
  const label = document.getElementById('staci-toggle-label');
  const input = document.getElementById('staci-input') as HTMLTextAreaElement | null;
  if (!panel) return;

  panel.setAttribute('aria-hidden', 'false');
  panel.removeAttribute('inert');
  if (iconChat) iconChat.style.display = 'none';
  if (iconClose) iconClose.style.display = 'block';
  if (label) label.style.display = 'none';
  hideBadge();
  try { localStorage.setItem(STORAGE_PANEL_KEY, 'true'); } catch { /* ignore */ }

  // Focus input after transition
  setTimeout(() => { if (input && !isSending) input.focus(); }, 300);
}

function closePanel() {
  const panel = document.getElementById('staci-panel');
  const iconChat = document.getElementById('staci-icon-chat');
  const iconClose = document.getElementById('staci-icon-close');
  const label = document.getElementById('staci-toggle-label');
  if (!panel) return;

  panel.setAttribute('aria-hidden', 'true');
  panel.setAttribute('inert', '');
  if (iconChat) iconChat.style.display = 'block';
  if (iconClose) iconClose.style.display = 'none';
  if (label) label.style.display = '';
  try { localStorage.removeItem(STORAGE_PANEL_KEY); } catch { /* ignore */ }
}

function isPanelOpen() {
  return document.getElementById('staci-panel')?.getAttribute('aria-hidden') === 'false';
}

// ─── Product Card Types ─────────────────────────────────────

interface ProductCard {
  cardIndex: number;
  title: string;
  handle: string;
  price: string;
  compareAtPrice: string;
  availableForSale: boolean;
  imageUrl: string;
}

/** Render product cards below a message bubble */
function renderProductCards(cards: ProductCard[], container: HTMLElement) {
  if (!cards.length) return;
  const messagesEl = document.getElementById('staci-messages');
  if (!messagesEl) return;

  const row = document.createElement('div');
  row.className = 'staci-products';

  for (const card of cards) {
    const onSale = parseFloat(card.compareAtPrice) > parseFloat(card.price);
    // Shopify CDN resize for thumbnails
    const imgSrc = card.imageUrl.includes('cdn.shopify.com')
      ? `${card.imageUrl}&width=300&height=300&crop=center`
      : card.imageUrl;

    const a = document.createElement('a');
    a.className = 'staci-product-card';
    a.href = `/shop/${encodeURIComponent(card.handle)}/`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = `
      <span class="staci-product-card__number">#${card.cardIndex}</span>
      ${onSale ? '<span class="staci-product-card__badge">Sale</span>' : ''}
      <img class="staci-product-card__img" src="${escapeAttr(imgSrc)}" alt="${escapeHtml(card.title)}" loading="lazy" />
      <div class="staci-product-card__info">
        <span class="staci-product-card__title">${escapeHtml(card.title)}</span>
        <span class="staci-product-card__price">${onSale ? `<s>$${escapeHtml(card.compareAtPrice)}</s> ` : ''}$${escapeHtml(card.price)}</span>
      </div>
    `;
    row.appendChild(a);
  }

  // Stop shimmer when images load or fail
  row.querySelectorAll<HTMLImageElement>('.staci-product-card__img').forEach(img => {
    const markLoaded = () => img.classList.add('staci-loaded');
    if (img.complete) markLoaded();
    else {
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', markLoaded, { once: true });
    }
  });

  // Insert after the container (the bot message div)
  container.after(row);
  scrollToBottom();
}

// ─── SSE Stream Reader ──────────────────────────────────────

interface StreamResult {
  text: string;
  products: ProductCard[];
}

async function readStream(response: Response, bubble: HTMLElement, container: HTMLElement): Promise<StreamResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  let products: ProductCard[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);

        // Check for products event (sent before LLM tokens) — render immediately
        if (parsed.products) {
          products = parsed.products;
          renderProductCards(products, container);
          continue;
        }

        const token = parsed.response || '';
        if (token) {
          fullText += token;
          cancelAnimationFrame(_streamRAF);
          _streamRAF = requestAnimationFrame(() => {
            bubble.innerHTML = renderStreamingMarkdown(fullText);
            scrollToBottom();
          });
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }

  // Gracefully fade out the streaming cursor, then render final markdown
  bubble.classList.add('staci-streaming--done');
  await new Promise(r => setTimeout(r, 300));
  bubble.classList.remove('staci-streaming', 'staci-streaming--done');
  bubble.innerHTML = renderMarkdown(fullText);
  return { text: fullText, products };
}

// ─── Send Message ─────────────────────────────────────────

async function sendMessage(text: string) {
  if (isSending) return;

  hideChips();
  addUserBubble(text);
  conversationHistory.push({ role: 'user', content: text });
  saveSession();
  lockSend();

  showTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversationHistory.slice(-20),
        stream: true,
        pageContext: { url: window.location.href, title: document.title },
        sessionId: getSessionId(),
      }),
    });

    removeTyping();

    if (!res.ok) {
      // Handle rate limiting specifically
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        addErrorBubble(
          (data as any).error || 'Too many messages — please wait a moment.',
          () => sendMessage(text)
        );
        // Remove user message from history since we'll retry
        conversationHistory.pop();
        saveSession();
        unlockSend();
        return;
      }
      throw new Error('Request failed');
    }

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream') && res.body) {
      // ─── Streaming response ─────────────────────────────
      const { container, bubble } = addStreamingBubble();
      _isStreaming = true;
      const streamResult = await readStream(res, bubble, container);
      _isStreaming = false;
      container.classList.remove('staci-msg--stream-start');
      const reply = streamResult.text || "Sorry, I couldn't process that. Please try again.";

      // Parse out follow-up suggestions and re-render clean text
      const { clean, suggestions } = parseSuggestions(reply);
      bubble.innerHTML = renderMarkdown(clean);

      conversationHistory.push({ role: 'assistant', content: clean });
      saveSession();

      // Cards already rendered during streaming (in readStream)
      if (suggestions.length) updateChips(suggestions);
    } else {
      // ─── Non-streaming fallback ─────────────────────────
      const data = await res.json();
      const rawReply = data.reply || "Sorry, I couldn't process that. Please try again.";

      const { clean, suggestions } = parseSuggestions(rawReply);

      conversationHistory.push({ role: 'assistant', content: clean });
      saveSession();
      const msgEl = addBotBubble(clean);

      // Render product cards below the message
      if (data.products?.length) renderProductCards(data.products, msgEl);

      if (suggestions.length) updateChips(suggestions);
    }

    // Show badge if panel was closed while response arrived
    if (!isPanelOpen()) showBadge();

    unlockSend();
  } catch {
    _isStreaming = false;
    removeTyping();
    // Remove any partial streaming bubble left by a mid-stream error
    const partialBubble = document.querySelector('.staci-msg--stream-start');
    if (partialBubble) partialBubble.remove();
    unlockSend();
    // Save the text we tried to send for retry
    const failedText = text;
    // Remove the user message that failed
    conversationHistory.pop();
    saveSession();
    addErrorBubble("Sorry, I couldn't connect.", () => sendMessage(failedText));
  }
}

// ─── Shared submit handler (avoids form submit event entirely) ──

function handleFormSubmit() {
  if (isSending) return;
  const textarea = document.getElementById('staci-input') as HTMLTextAreaElement | null;
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) return;
  textarea.value = '';
  textarea.style.height = 'auto';
  updateCharCount('');
  setSendEnabled(textarea);
  sendMessage(text);
}

// ─── Event Listeners (delegation for View Transitions) ────

// Toggle button
document.addEventListener('click', (e) => {
  const toggle = (e.target as Element).closest('#staci-toggle');
  if (!toggle) return;
  if (isPanelOpen()) closePanel();
  else openPanel();
});

// Escape closes; Tab traps focus inside panel; Enter in textarea submits
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isPanelOpen()) { closePanel(); return; }

  // Focus trap
  if (e.key === 'Tab' && isPanelOpen()) {
    const panel = document.getElementById('staci-panel');
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), a[href]'
    ));
    if (focusable.length < 2) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }

  // Enter in textarea submits (Shift+Enter = newline)
  if (e.key === 'Enter' && !e.shiftKey && (e.target as Element).id === 'staci-input') {
    e.preventDefault();
    handleFormSubmit();
  }
});

// Header close button
document.addEventListener('click', (e) => {
  if ((e.target as Element).closest('#staci-header-close')) {
    closePanel();
  }
});

// Header reset button
document.addEventListener('click', (e) => {
  if ((e.target as Element).closest('#staci-header-reset')) {
    resetConversation();
  }
});

// Quick reply chips & inline suggestion pills
document.addEventListener('click', (e) => {
  const chip = (e.target as Element).closest('.staci-chip, .staci-suggestion-pill') as HTMLElement | null;
  if (!chip || isSending) return;
  const msg = chip.dataset.msg;
  if (msg) sendMessage(msg);
});

// Block native form submission entirely — prevents Astro ClientRouter
// from intercepting it as a navigation. Use capture phase so we run
// before any other submit listeners (including Astro's).
document.addEventListener('submit', (e) => {
  const form = (e.target as Element).closest('#staci-form');
  if (!form) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  handleFormSubmit();
}, true);

// Character counter
function updateCharCount(value: string) {
  const charCount = document.getElementById('staci-char-count');
  if (!charCount) return;
  const len = value.length;
  const max = 500;
  if (len > 400) {
    charCount.textContent = `${len}/${max}`;
    charCount.style.display = 'block';
    charCount.classList.toggle('staci-char-count--warn', len >= 480);
  } else {
    charCount.textContent = '';
    charCount.style.display = 'none';
    charCount.classList.remove('staci-char-count--warn');
  }
}

function setSendEnabled(textarea: HTMLTextAreaElement) {
  const btn = document.getElementById('staci-send') as HTMLButtonElement | null;
  if (btn) btn.disabled = textarea.value.trim().length === 0;
}

document.addEventListener('input', (e) => {
  if ((e.target as Element).id === 'staci-input') {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    updateCharCount(ta.value);
    setSendEnabled(ta);
  }
});

// ─── Timestamps ───────────────────────────────────────────

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function updateTimestamps() {
  document.querySelectorAll<HTMLElement>('.staci-msg[data-ts]').forEach(msg => {
    const ts = parseInt(msg.dataset.ts || '0', 10);
    const timeEl = msg.querySelector<HTMLElement>('.staci-msg__time');
    if (timeEl && ts) timeEl.textContent = timeAgo(ts);
  });
}

// ─── Proactive Greeting Bubble ───────────────────────────
const GREETING_SHOWN_KEY = 'staci_greeting_shown';

function getPageGreeting(): string {
  const path = window.location.pathname.toLowerCase();
  if (path.startsWith('/shop/') && path !== '/shop/' && path !== '/shop') {
    return 'Have questions about this piece? I can help!';
  }
  if (path === '/shop' || path === '/shop/') {
    return 'Looking for something specific? I can search for you!';
  }
  if (path.includes('about') || path.includes('mission')) {
    return 'Want to learn how your purchase changes lives?';
  }
  return 'Hi! Need help finding something?';
}

function showGreeting() {
  const el = document.getElementById('staci-greeting');
  const textEl = document.getElementById('staci-greeting-text');
  if (!el || !textEl) return;
  textEl.textContent = getPageGreeting();
  el.style.display = 'block';
  el.setAttribute('aria-hidden', 'false');
}

function dismissGreeting() {
  const el = document.getElementById('staci-greeting');
  if (!el) return;
  el.classList.add('staci-greeting--out');
  setTimeout(() => { el.style.display = 'none'; }, 300);
  try { sessionStorage.setItem(GREETING_SHOWN_KEY, 'true'); } catch {}
}

// Greeting interactions
document.addEventListener('click', (e) => {
  const el = e.target as Element;
  if (el.closest('#staci-greeting-close')) { dismissGreeting(); return; }
  if (el.closest('#staci-greeting')) { dismissGreeting(); openPanel(); }
});

// ─── Init ─────────────────────────────────────────────────
restoreSession();
setInterval(updateTimestamps, 30_000);

// Send button starts disabled (textarea is empty)
const _sendBtn = document.getElementById('staci-send') as HTMLButtonElement | null;
if (_sendBtn) _sendBtn.disabled = true;

// Show proactive greeting after 5s for first-time visitors (no existing session, panel not open)
if (!conversationHistory.length && !isPanelOpen() && !sessionStorage.getItem(GREETING_SHOWN_KEY)) {
  setTimeout(() => {
    if (!isPanelOpen()) showGreeting();
  }, 5000);
}

// Dismiss greeting whenever the toggle is clicked (panel opening)
const _toggleEl = document.getElementById('staci-toggle');
if (_toggleEl) {
  _toggleEl.addEventListener('click', dismissGreeting);
}
