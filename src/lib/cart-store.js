// ═══════════════════════════════════════════════════════
//  Sunny & Ranney — Cart Store with Shopify Cart API
//  Optimistic localStorage UI + Shopify server-side cart.
//  Shopify owns the cart; localStorage is a fast cache.
// ═══════════════════════════════════════════════════════

const STORAGE_KEY = 'sr_cart';
const CART_ID_KEY = 'sr_cart_id';
const CHECKOUT_URL_KEY = 'sr_checkout_url';
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

// ─── Shopify Cart API helpers ──────────────────────────

function getShopifyConfig() {
  if (typeof window === 'undefined') return null;
  const domain = window.__SHOPIFY_DOMAIN || 'sunnyandranney.myshopify.com';
  const token = window.__SHOPIFY_TOKEN || '';
  if (!token) return null;
  return { domain, token };
}

async function shopifyCartFetch(query, variables = {}) {
  const config = getShopifyConfig();
  if (!config) return null;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://${config.domain}/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': config.token,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Shopify ${res.status}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      const json = await res.json();
      return json.data ?? null;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  console.error('[cart] Shopify fetch failed after retries:', lastError);
  return null;
}

const CART_FRAGMENT = `
  fragment CartFields on Cart {
    id
    checkoutUrl
    totalQuantity
    cost {
      totalAmount { amount currencyCode }
    }
    lines(first: 50) {
      edges {
        node {
          id
          quantity
          merchandise {
            ... on ProductVariant {
              id
              title
              availableForSale
              price { amount }
              product {
                title
                handle
                images(first: 1) { edges { node { url } } }
              }
            }
          }
        }
      }
    }
  }
`;

function getStoredCartId() {
  try { return localStorage.getItem(CART_ID_KEY); } catch { return null; }
}

function storeCartId(id) {
  try { localStorage.setItem(CART_ID_KEY, id); } catch {}
}

function getStoredCheckoutUrl() {
  try { return localStorage.getItem(CHECKOUT_URL_KEY); } catch { return null; }
}

function storeCheckoutUrl(url) {
  try { localStorage.setItem(CHECKOUT_URL_KEY, url); } catch {}
}

function clearShopifyCart() {
  try {
    localStorage.removeItem(CART_ID_KEY);
    localStorage.removeItem(CHECKOUT_URL_KEY);
  } catch {}
}

// ─── Error events ────────────────────────────────────
// Subscribers can listen for Shopify-side errors (e.g. item unavailable)
const errorListeners = new Set();

function notifyError(error) {
  errorListeners.forEach(fn => fn(error));
}

// Handle userErrors from Shopify mutations
function handleUserErrors(userErrors, context) {
  if (!userErrors?.length) return false;
  const msg = userErrors.map(e => e.message).join('; ');
  console.warn(`[cart] Shopify ${context}:`, msg);
  notifyError({ type: context, message: msg, errors: userErrors });
  return true;
}

// Reconcile Shopify cart response → update localStorage cache
// This is the source of truth: Shopify tells us what's actually in the cart.
function reconcileFromShopify(shopifyCart) {
  if (!shopifyCart) return;

  storeCartId(shopifyCart.id);
  storeCheckoutUrl(shopifyCart.checkoutUrl);

  const lines = shopifyCart.lines?.edges ?? [];
  const previousItems = load();
  const items = lines.map(({ node }) => {
    const v = node.merchandise;
    return {
      variantId: v.id,
      title: v.product?.title || '',
      variantTitle: v.title === 'Default Title' ? '' : (v.title || ''),
      price: parseFloat(v.price?.amount || '0'),
      image: v.product?.images?.edges?.[0]?.node?.url || '',
      handle: v.product?.handle || '',
      qty: node.quantity,
      lineId: node.id, // Shopify line ID — needed for updates/removes
      available: v.availableForSale !== false,
    };
  });

  // Detect items that were in localStorage but Shopify pruned (unavailable/deleted)
  const shopifyVariantIds = new Set(items.map(i => i.variantId));
  const pruned = previousItems.filter(i => !shopifyVariantIds.has(i.variantId));
  if (pruned.length > 0) {
    const names = pruned.map(i => i.title).join(', ');
    notifyError({ type: 'items_unavailable', message: `Removed from cart (no longer available): ${names}`, pruned });
  }

  save(items);
  notify(items);
}

// Map of variantId → Shopify line ID (for updates/removes)
function getLineId(variantId) {
  const items = load();
  const item = items.find(i => i.variantId === variantId);
  return item?.lineId || null;
}

// ─── Shopify Cart mutations (fire-and-forget with reconciliation) ──

let _syncQueue = Promise.resolve();

// Serialize all Shopify mutations to avoid race conditions
function enqueueSync(fn) {
  _syncQueue = _syncQueue.then(fn).catch(() => {});
}

async function shopifyCreateCart(items) {
  const lines = items.map(i => ({
    merchandiseId: i.variantId,
    quantity: i.qty,
  }));

  const data = await shopifyCartFetch(`
    ${CART_FRAGMENT}
    mutation CartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `, { input: { lines } });

  const result = data?.cartCreate;
  if (result?.cart) {
    handleUserErrors(result.userErrors, 'cartCreate');
    reconcileFromShopify(result.cart);
  }
  return result;
}

async function shopifyAddLines(cartId, newItems) {
  const lines = newItems.map(i => ({
    merchandiseId: i.variantId,
    quantity: i.qty,
  }));

  const data = await shopifyCartFetch(`
    ${CART_FRAGMENT}
    mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `, { cartId, lines });

  const result = data?.cartLinesAdd;
  if (result?.cart) {
    handleUserErrors(result.userErrors, 'cartLinesAdd');
    reconcileFromShopify(result.cart);
  }
  return result;
}

async function shopifyUpdateLines(cartId, updates) {
  const lines = updates.map(u => ({
    id: u.lineId,
    quantity: u.qty,
  }));

  const data = await shopifyCartFetch(`
    ${CART_FRAGMENT}
    mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
      cartLinesUpdate(cartId: $cartId, lines: $lines) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `, { cartId, lines });

  const result = data?.cartLinesUpdate;
  if (result?.cart) {
    handleUserErrors(result.userErrors, 'cartLinesUpdate');
    reconcileFromShopify(result.cart);
  }
  return result;
}

async function shopifyRemoveLines(cartId, lineIds) {
  const data = await shopifyCartFetch(`
    ${CART_FRAGMENT}
    mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `, { cartId, lineIds });

  const result = data?.cartLinesRemove;
  if (result?.cart) {
    handleUserErrors(result.userErrors, 'cartLinesRemove');
    reconcileFromShopify(result.cart);
  }
  return result;
}

async function shopifyFetchCart(cartId) {
  const data = await shopifyCartFetch(`
    ${CART_FRAGMENT}
    query GetCart($cartId: ID!) {
      cart(id: $cartId) { ...CartFields }
    }
  `, { cartId });

  return data?.cart ?? null;
}

// ─── Cross-tab sync ─────────────────────────────────
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      _cache = null;
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
    fn(load());
    return () => listeners.delete(fn);
  },

  /** Subscribe to cart errors (Shopify userErrors, unavailable items, network failures). Returns unsubscribe fn. */
  onError(fn) {
    errorListeners.add(fn);
    return () => errorListeners.delete(fn);
  },

  getItems() { return load(); },
  getCount() { return load().reduce((n, i) => n + i.qty, 0); },
  getTotal() { return load().reduce((s, i) => s + i.price * i.qty, 0); },
  formatMoney(amount) { return currencyFmt.format(amount); },

  /** Add item. Optimistic UI update, then sync to Shopify. */
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

    // Sync to Shopify in background
    enqueueSync(async () => {
      const cartId = getStoredCartId();
      if (cartId) {
        // Cart exists — check if this variant already has a line
        const existingLineId = getLineId(product.variantId);
        if (existingLineId) {
          // Update existing line quantity
          const current = load().find(i => i.variantId === product.variantId);
          if (current) {
            await shopifyUpdateLines(cartId, [{ lineId: existingLineId, qty: current.qty }]);
          }
        } else {
          // Add new line
          await shopifyAddLines(cartId, [{ variantId: product.variantId, qty }]);
        }
      } else {
        // No cart yet — create one with all current items
        await shopifyCreateCart(load());
      }
    });

    return items;
  },

  /** Remove item by variantId. Optimistic, then sync. */
  remove(variantId) {
    const lineId = getLineId(variantId);
    const items = load();
    const idx = items.findIndex(i => i.variantId === variantId);
    if (idx >= 0) items.splice(idx, 1);
    save(items);
    notify(items);

    if (items.length === 0) {
      clearShopifyCart();
    } else {
      enqueueSync(async () => {
        const cartId = getStoredCartId();
        if (cartId && lineId) {
          await shopifyRemoveLines(cartId, [lineId]);
        }
      });
    }

    return items;
  },

  /** Update quantity. Optimistic, then sync. */
  updateQty(variantId, qty) {
    const lineId = getLineId(variantId);
    const items = load();
    const item = items.find(i => i.variantId === variantId);
    if (item) {
      item.qty = Math.min(Math.max(1, qty), 20);
    }
    save(items);
    notify(items);

    enqueueSync(async () => {
      const cartId = getStoredCartId();
      if (cartId && lineId) {
        await shopifyUpdateLines(cartId, [{ lineId, qty: Math.min(Math.max(1, qty), 20) }]);
      }
    });

    return items;
  },

  /** Clear cart */
  clear() {
    save([]);
    notify([]);
    clearShopifyCart();
  },

  /** Get Shopify checkout URL (server-validated, not a manual permalink). */
  getCheckoutUrl() {
    return getStoredCheckoutUrl() || null;
  },

  /**
   * Ensure the Shopify cart is in sync. Call on page load.
   * - If we have a stored cartId, fetch it from Shopify and reconcile.
   * - If the Shopify cart is gone (expired/invalid), recreate it.
   * - Prunes deleted variants, updates prices, provides valid checkoutUrl.
   */
  async sync() {
    const items = load();
    const cartId = getStoredCartId();

    if (!items.length) {
      clearShopifyCart();
      return;
    }

    if (cartId) {
      const shopifyCart = await shopifyFetchCart(cartId);
      if (shopifyCart) {
        reconcileFromShopify(shopifyCart);
        return;
      }
      // Cart expired or invalid — fall through to create
      clearShopifyCart();
    }

    // No valid Shopify cart — create one from localStorage items
    await shopifyCreateCart(items);
  },

  /**
   * Create a one-off cart for Buy Now (single item, immediate checkout).
   * Returns the checkoutUrl or null.
   */
  async createBuyNowCart(variantId, qty = 1) {
    const config = getShopifyConfig();
    if (!config) {
      // Fallback to legacy permalink if no API token
      const domain = (typeof window !== 'undefined' && window.__SHOPIFY_DOMAIN) || 'sunnyandranney.myshopify.com';
      const numericId = variantId.includes('/') ? variantId.split('/').pop() : variantId;
      return `https://${domain}/cart/${numericId}:${qty}`;
    }

    const result = await shopifyCreateCart([{ variantId, qty }]);
    if (result?.cart?.checkoutUrl) {
      return result.cart.checkoutUrl;
    }

    if (result?.userErrors?.length) {
      handleUserErrors(result.userErrors, 'buyNow');
    }
    return null;
  },
};

// ─── Boot: sync with Shopify on page load ────────────
if (typeof window !== 'undefined') {
  // Defer sync so it doesn't block initial render
  if (load().length > 0) {
    setTimeout(() => cart.sync(), 100);
  }
}

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
