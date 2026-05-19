// End-to-end smoke test for the cart against http://localhost:8788.
// Tests the real /api/cart proxy against the real Shopify Storefront API.
//
// Test fixtures: two confirmed-in-stock products from different categories,
// both with images so the PDP renders fully:
//   A: partridge-espresso-counter-chair-cfc  (variant 52606444634396, qty 1, $250)
//   B: woven-wood-basket-black-mdp           (variant 52606490280220, qty 2, $30)

import { chromium } from 'playwright';

const BASE = 'http://localhost:8788';
const PDP_A = `${BASE}/shop/partridge-espresso-counter-chair-cfc/`;
const VAR_A = 'gid://shopify/ProductVariant/52606444634396';
const VAR_B = 'gid://shopify/ProductVariant/52606490280220';

const log = (...a) => console.log('[smoke]', ...a);
const ok = (cond, label) => console.log(`${cond ? '✓' : '✗'} ${label}`);
let failed = 0;
const check = (cond, label) => {
  if (!cond) failed++;
  ok(cond, label);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.clearCookies();
const page = await ctx.newPage();

const cartRequests = [];
let pendingResponses = 0;
page.on('request', (req) => {
  if (req.url().includes('/api/cart')) {
    cartRequests.push({ method: req.method(), body: req.postData(), at: Date.now() });
    pendingResponses++;
  }
});
page.on('response', (res) => {
  if (res.url().includes('/api/cart')) pendingResponses--;
});
page.on('pageerror', (err) => log('pageerror:', err.message));
page.on('console', (msg) => {
  const t = msg.text();
  if (msg.type() === 'error' || t.startsWith('[cart]')) log(`console.${msg.type()}:`, t);
});

/** Wait until every in-flight /api/cart request has returned. */
async function drainCart() {
  const deadline = Date.now() + 15000;
  while (pendingResponses > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ───────────────────────────── 1. Cold load + add ─────────────────────────────
log('Loading PDP A…');
await page.goto(PDP_A, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.addToCart === 'function', { timeout: 15000 });
await page.waitForTimeout(1200); // let astro:page-load bind PDP click handler
check(true, 'Preact island wires window.addToCart');

cartRequests.length = 0;
await page.locator('#add-to-cart').click();
await page.waitForSelector('.cart-drawer[aria-hidden="false"]', { timeout: 8000 });
check(true, 'Drawer opens on add');

await page.waitForSelector('.cart-item', { timeout: 8000 });
const initialItemCount = await page.locator('.cart-item').count();
check(initialItemCount === 1, `Drawer shows 1 line (got ${initialItemCount})`);

await page.waitForFunction(() => {
  const el = document.getElementById('cart-count');
  return el && el.textContent === '1' && el.style.display !== 'none';
}, { timeout: 8000 });
check(true, 'Header badge updates to 1');

await page.waitForTimeout(1500); // let mutation settle
const postCalls = cartRequests.filter((r) => r.method === 'POST');
const addCalls = postCalls.filter((r) => r.body && JSON.parse(r.body).op === 'add');
check(addCalls.length === 1, `Exactly one /api/cart add call (got ${addCalls.length})`);
const addBody = JSON.parse(addCalls[0].body);
check(addBody.lines?.length === 1, 'Add call has 1 line');
check(addBody.seedIfMissing === true, 'Add call has seedIfMissing:true');
check(addBody.lines[0].merchandiseId === VAR_A, 'Add call has correct merchandiseId');

const subtotalText = await page.locator('.cart-footer__total').textContent();
check(/^\$\d/.test(subtotalText || ''), `Subtotal currency-formatted: ${subtotalText}`);

// ───────────────────────────── 2. Cookies set correctly ──────────────────────
const cookies1 = await ctx.cookies();
const cartId1 = cookies1.find((c) => c.name === 'sr_cart_id');
const cartN1 = cookies1.find((c) => c.name === 'sr_cart_n');
check(!!cartId1 && cartId1.httpOnly, 'sr_cart_id cookie is httpOnly');
check(cartN1?.value === '1', `sr_cart_n cookie = 1 (got ${cartN1?.value})`);
check(cartN1?.httpOnly === false, 'sr_cart_n cookie is NOT httpOnly (readable by pre-paint script)');

// ───────────────────────────── 3. Race fix ───────────────────────────────────
log('Race test: add B, then immediately remove A while B is still pending…');
cartRequests.length = 0;
await page.evaluate(({ VAR_B }) => {
  window.addToCart({
    variantId: VAR_B,
    title: 'Woven Wood Basket - Black',
    price: '30',
    image: '',
    handle: 'woven-wood-basket-black-mdp',
    variantTitle: '',
  });
}, { VAR_B });

// Wait until 2 lines render, then remove A
await page.waitForFunction(() => document.querySelectorAll('.cart-item').length === 2, { timeout: 5000 });

// Locate A's remove button by title match (so we're not order-dependent)
const partridgeRemove = page.locator('.cart-item:has(.cart-item__title:has-text("Partridge")) .cart-item__remove');
await partridgeRemove.click();

// Settle and verify: A is gone, B remains, badge tracks
await page.waitForTimeout(3500);
const finalLines = await page.locator('.cart-item').count();
check(finalLines === 1, `After race, exactly 1 line remains (got ${finalLines})`);
const remainingTitle = (await page.locator('.cart-item__title').first().textContent()) || '';
check(remainingTitle.includes('Woven Wood Basket'), `Remaining line is B (got "${remainingTitle}")`);
const badgeAfterRace = await page.locator('#cart-count').textContent();
check(badgeAfterRace === '1', `Badge after race = 1 (got ${badgeAfterRace})`);

// ───────────────────────────── 4. Qty + tracks ───────────────────────────────
const plusBtn = page.locator('.cart-item__qty button').nth(1);
await plusBtn.click();
await page.waitForFunction(
  () => document.querySelector('.cart-item__qty span')?.textContent === '2',
  { timeout: 5000 },
);
check(true, 'Qty + bumps line to 2');
await page.waitForFunction(
  () => document.getElementById('cart-count')?.textContent === '2',
  { timeout: 5000 },
);
check(true, 'Badge tracks qty change → 2');

// ───────────────────────────── 5. Pre-paint badge from sr_cart_n cookie ─────
log('Pre-paint badge test…');
// Wait for every cart mutation to settle so the cookie reflects server state.
await drainCart();
const cookies2 = await ctx.cookies();
const countCookie = cookies2.find((c) => c.name === 'sr_cart_n');
check(countCookie?.value === '2', `sr_cart_n cookie now 2 (got ${countCookie?.value})`);

// Fetch the raw HTML for a PDP with the cookie set and assert the inline
// pre-paint script is present. The script runs before bundled JS, so a
// real browser paints the badge from the cookie before first frame.
const cookieHeader = cookies2
  .filter((c) => c.domain === 'localhost')
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');
const rawHtml = await (
  await fetch(PDP_A, { headers: { Cookie: cookieHeader } })
).text();
const hasPrePaintScript = /sr_cart_n=\\d\+\)/.test(rawHtml) || rawHtml.includes("sr_cart_n=(\\d+)");
check(hasPrePaintScript, 'Pre-paint inline script present in HTML');
const badgeRenderedHidden = /<span[^>]*id="cart-count"[^>]*style="display:none;"[^>]*>0<\/span>/.test(rawHtml);
check(badgeRenderedHidden, 'Badge ships hidden in SSR HTML (inline script reveals it)');

// Also verify in a real browser that the badge ends up populated correctly
// when we hit the page with the cookie set, regardless of how fast first
// paint is (this is the user-visible outcome).
const ctx2 = await browser.newContext();
await ctx2.addCookies(cookies2.filter((c) => c.domain === 'localhost'));
const page2 = await ctx2.newPage();
await page2.goto(PDP_A, { waitUntil: 'domcontentloaded' });
const badgeText = await page2.locator('#cart-count').textContent();
const badgeVisible = await page2.locator('#cart-count').evaluate((el) => el.style.display !== 'none');
check(badgeText === '2', `Reloaded badge text = 2 (got "${badgeText}")`);
check(badgeVisible, 'Reloaded badge is visible');
await ctx2.close();

// ───────────────────────────── 6. Esc + reopen ───────────────────────────────
await page.keyboard.press('Escape');
await page.waitForFunction(
  () => document.querySelector('.cart-drawer')?.getAttribute('aria-hidden') === 'true',
  { timeout: 3000 },
);
check(true, 'Esc closes drawer');
await page.evaluate(() => window.openCart?.());
await page.waitForSelector('.cart-drawer[aria-hidden="false"]', { timeout: 3000 });
check(true, 'window.openCart re-opens drawer');

// ───────────────────────────── 7. Remove last line → cookie clears ───────────
const lastRemove = page.locator('.cart-item__remove').first();
await lastRemove.click();
await page.waitForFunction(
  () => document.querySelectorAll('.cart-item').length === 0,
  { timeout: 5000 },
);
check(true, 'Last line removed');
// Wait for the remove to settle on the server, then read the cookie.
await drainCart();
const cookies3 = await ctx.cookies();
const countCookie3 = cookies3.find((c) => c.name === 'sr_cart_n');
check(
  !countCookie3 || countCookie3.value === '' || countCookie3.value === '0',
  `sr_cart_n cleared after empty cart (got "${countCookie3?.value}")`,
);

// ───────────────────────────── 8. /api/cart hardening (origin guard) ────────
log('Direct proxy security checks…');
// Browsers forbid scripts from setting the Origin header, so this test runs
// via Node fetch where we can spoof it (matches the real cross-site abuse path
// where another site's server would proxy a request to ours).
const crossOriginRes = await fetch('http://localhost:8788/api/cart/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
  body: JSON.stringify({ op: 'fetch' }),
});
check(crossOriginRes.status === 403, `Cross-origin POST blocked with 403 (got ${crossOriginRes.status})`);

const badPayload = await page.evaluate(async () => {
  const res = await fetch('http://localhost:8788/api/cart/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'add', lines: [{ merchandiseId: 'not-a-gid', quantity: 1 }], seedIfMissing: true }),
  });
  return res.status;
});
check(badPayload === 400, `Invalid merchandiseId rejected with 400 (got ${badPayload})`);

const qtyTooHigh = await page.evaluate(async () => {
  const res = await fetch('http://localhost:8788/api/cart/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'add',
      lines: [{ merchandiseId: 'gid://shopify/ProductVariant/52606444634396', quantity: 999 }],
      seedIfMissing: true,
    }),
  });
  return res.status;
});
check(qtyTooHigh === 400, `Qty > cap rejected with 400 (got ${qtyTooHigh})`);

// ───────────────────────────── 9. Buy-Now ephemeral ─────────────────────────
log('Buy-Now should not affect saved cart…');
const beforeBN = (await ctx.cookies()).find((c) => c.name === 'sr_cart_id')?.value;
const bnResult = await page.evaluate(async (VAR_A) => {
  const res = await fetch('/api/cart/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'buyNow', merchandiseId: VAR_A, quantity: 1 }),
  });
  return res.json();
}, VAR_A);
check(typeof bnResult.ephemeralCheckoutUrl === 'string' && bnResult.ephemeralCheckoutUrl.startsWith('https://'),
  'Buy-Now returns ephemeralCheckoutUrl');
const afterBN = (await ctx.cookies()).find((c) => c.name === 'sr_cart_id')?.value;
check(beforeBN === afterBN, 'Buy-Now does NOT modify sr_cart_id cookie');

await browser.close();

console.log('');
if (failed === 0) {
  console.log('✓ ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.log(`✗ ${failed} CHECKS FAILED`);
  process.exit(1);
}
