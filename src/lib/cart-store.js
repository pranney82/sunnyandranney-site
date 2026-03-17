// ═══════════════════════════════════════════════════════
//  Sunny & Ranney — Lightweight Cart Store
//  Zero dependencies, ~2KB. Pub/sub pattern with
//  localStorage persistence + in-memory cache.
// ═══════════════════════════════════════════════════════

const STORAGE_KEY = 'sr_cart';
const listeners = new Set();

// In-memory cache — avoids JSON.parse on every read
let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    _cache = [];
  }
  return _cache;
}

function save(items) {
  _cache = items;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function notify(items) {
  listeners.forEach(fn => fn(items));
}

// ─── Cross-tab sync ─────────────────────────────────
// When another tab changes localStorage, invalidate cache and notify
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      _cache = null; // bust cache so load() re-reads
      notify(load());
    }
  });
}

// ─── Formatting ──────────────────────────────────────
const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
});

// ─── Public API ────────────────────────────────────────

export const cart = {
  /** Subscribe to cart changes. Returns unsubscribe fn. */
  subscribe(fn) {
    listeners.add(fn);
    fn(load()); // immediate call with current state
    return () => listeners.delete(fn);
  },

  getItems() { return load(); },
  getCount() { return load().reduce((n, i) => n + i.qty, 0); },
  getTotal() { return load().reduce((s, i) => s + i.price * i.qty, 0); },
  formatMoney(amount) { return currencyFmt.format(amount); },

  /** Add item. If already in cart, increment qty. Supports qty param. */
  add(product, qty = 1) {
    const items = load();
    const idx = items.findIndex(i => i.variantId === product.variantId);
    if (idx >= 0) {
      items[idx].qty = Math.min(items[idx].qty + qty, 20);
    } else {
      items.push({ ...product, qty: Math.min(qty, 20) });
    }
    save(items);
    notify(items);
    return items;
  },

  /** Remove item by variantId */
  remove(variantId) {
    const items = load();
    const idx = items.findIndex(i => i.variantId === variantId);
    if (idx >= 0) items.splice(idx, 1);
    save(items);
    notify(items);
    return items;
  },

  /** Update quantity */
  updateQty(variantId, qty) {
    const items = load();
    const item = items.find(i => i.variantId === variantId);
    if (item) {
      item.qty = Math.min(Math.max(1, qty), 20);
    }
    save(items);
    notify(items);
    return items;
  },

  /** Clear cart */
  clear() {
    save([]);
    notify([]);
  },

  /** Build Shopify checkout URL from cart items */
  getCheckoutUrl(storeDomain = 'sunnyandranney.myshopify.com') {
    const items = load();
    if (!items.length) return null;
    const lineItems = items.map(i => {
      // Extract numeric variant ID from Shopify GID
      const numericId = i.variantId.includes('/') ? i.variantId.split('/').pop() : i.variantId;
      return `${numericId}:${i.qty}`;
    }).join(',');
    return `https://${storeDomain}/cart/${lineItems}`;
  }
};

// ─── Wishlist (lightweight) ────────────────────────────

const WISH_KEY = 'sr_wishlist';

export const wishlist = {
  getItems() {
    try { return JSON.parse(localStorage.getItem(WISH_KEY)) || []; }
    catch { return []; }
  },

  toggle(productHandle) {
    const items = this.getItems();
    const idx = items.indexOf(productHandle);
    if (idx >= 0) {
      items.splice(idx, 1);
    } else {
      items.push(productHandle);
    }
    localStorage.setItem(WISH_KEY, JSON.stringify(items));
    return items;
  },

  has(productHandle) {
    return this.getItems().includes(productHandle);
  }
};

// ─── Recently Viewed ───────────────────────────────────

const RECENT_KEY = 'sr_recent';
const MAX_RECENT = 12;

export const recentlyViewed = {
  getItems() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
    catch { return []; }
  },

  add(product) {
    const items = this.getItems().filter(i => i.handle !== product.handle);
    items.unshift(product);
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  }
};
