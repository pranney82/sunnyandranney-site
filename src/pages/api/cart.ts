import type { APIRoute } from 'astro';
import {
  CART_CREATE,
  CART_FETCH,
  CART_LINES_ADD,
  CART_LINES_REMOVE,
  CART_LINES_UPDATE,
} from '@/lib/cart/queries';
import type { ShopifyCart, ShopifyUserError } from '@/lib/cart/types';

// /api/cart — Storefront cart proxy.
//
// Responsibilities:
//  • Origin lockdown — only same-origin POSTs run mutations.
//  • Cart identity — reads/writes the httpOnly `sr_cart_id` cookie. The
//    client never sees or sends it.
//  • Mirror upstream HTTP status (4xx/5xx surface to the client honestly).
//  • Set `sr_cart_n` cookie with totalQuantity so the next page render
//    can paint badges before JS boots (no flash-of-zero on cold loads).
//  • Always `Cache-Control: no-store`.
//  • Body size cap, schema validation.

export const prerender = false;

const SHOPIFY_API_VERSION = '2025-01';
const MAX_BODY_BYTES = 16 * 1024; // 16KB — generous for cart payloads
const CART_ID_COOKIE = 'sr_cart_id';
const CART_COUNT_COOKIE = 'sr_cart_n';
const COOKIE_MAX_AGE = 10 * 24 * 60 * 60; // 10 days — Shopify cart TTL

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
} as const;

type AddLine = { merchandiseId: string; quantity: number };
type UpdateLine = { id: string; quantity: number };

type ProxyOp =
  | { op: 'fetch' }
  | { op: 'create'; lines: AddLine[] }
  | { op: 'add'; lines: AddLine[]; seedIfMissing?: boolean }
  | { op: 'update'; lines: UpdateLine[] }
  | { op: 'remove'; lineIds: string[] }
  | { op: 'buyNow'; merchandiseId: string; quantity: number };

type ProxyResponse = {
  cart: ShopifyCart | null;
  userErrors: ShopifyUserError[];
  ephemeralCheckoutUrl?: string | null;
};

const MAX_LINE_QTY = 20;

// ─── HTTP entry ──────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request, locals }) => {
  // Astro's Cloudflare adapter provides bindings + env vars via locals.runtime.env.
  // Use this rather than `import { env } from 'cloudflare:workers'` — the latter
  // is a virtual module that requires wrangler auth to resolve in `astro dev`,
  // so it breaks the dev server on machines that aren't logged in to Cloudflare.
  const env = (locals as { runtime?: { env?: Record<string, string | undefined> } }).runtime?.env ?? (process.env as Record<string, string | undefined>);

  // Same-origin guard. Astro's Cloudflare adapter exposes the original
  // `Origin` header on the Request. Block cross-origin POSTs entirely so
  // a malicious site can't burn rate limits or seed carts in our cookies.
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (origin && host && new URL(origin).host !== host) {
    return jsonResponse(403, { cart: null, userErrors: [{ field: null, message: 'Cross-origin requests are not allowed.' }] });
  }

  const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { cart: null, userErrors: [{ field: null, message: 'Request body too large.' }] });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { cart: null, userErrors: [{ field: null, message: 'Invalid JSON body.' }] });
  }

  const parsed = parseRequest(body);
  if ('error' in parsed) {
    return jsonResponse(400, { cart: null, userErrors: [{ field: null, message: parsed.error }] });
  }

  const domain = env.SHOPIFY_STORE_DOMAIN || env.PUBLIC_SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_TOKEN || env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN;
  if (!domain || !token) {
    console.error('[api/cart] Shopify credentials missing in env');
    return jsonResponse(500, { cart: null, userErrors: [{ field: null, message: 'Cart service is not configured.' }] });
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const cartIdFromCookie = cookies[CART_ID_COOKIE] ?? null;

  try {
    const result = await execute(parsed.op, cartIdFromCookie, { domain, token });
    return jsonResponse(result.status, result.payload, result.setCookies);
  } catch (err) {
    console.error('[api/cart] handler threw', err);
    return jsonResponse(500, { cart: null, userErrors: [{ field: null, message: 'Unexpected error.' }] });
  }
};

// ─── Request validation ──────────────────────────────────────────────

function parseRequest(body: unknown): { op: ProxyOp } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Body must be a JSON object.' };
  const op = (body as { op?: unknown }).op;
  if (typeof op !== 'string') return { error: 'Missing "op" field.' };

  switch (op) {
    case 'fetch':
      return { op: { op: 'fetch' } };
    case 'add':
    case 'create': {
      const lines = (body as { lines?: unknown }).lines;
      if (!Array.isArray(lines) || lines.length === 0 || lines.length > 50) {
        return { error: 'Field "lines" must be a non-empty array (max 50).' };
      }
      const out: AddLine[] = [];
      for (const l of lines) {
        const merchandiseId = (l as { merchandiseId?: unknown })?.merchandiseId;
        const quantity = (l as { quantity?: unknown })?.quantity;
        if (typeof merchandiseId !== 'string' || !merchandiseId.startsWith('gid://shopify/ProductVariant/')) {
          return { error: 'Invalid merchandiseId.' };
        }
        if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 1 || quantity > MAX_LINE_QTY) {
          return { error: `Quantity must be 1..${MAX_LINE_QTY}.` };
        }
        out.push({ merchandiseId, quantity: Math.floor(quantity) });
      }
      if (op === 'create') return { op: { op: 'create', lines: out } };
      const seedIfMissing = (body as { seedIfMissing?: unknown }).seedIfMissing === true;
      return { op: { op: 'add', lines: out, seedIfMissing } };
    }
    case 'update': {
      const lines = (body as { lines?: unknown }).lines;
      if (!Array.isArray(lines) || lines.length === 0 || lines.length > 50) {
        return { error: 'Field "lines" must be a non-empty array (max 50).' };
      }
      const out: UpdateLine[] = [];
      for (const l of lines) {
        const id = (l as { id?: unknown })?.id;
        const quantity = (l as { quantity?: unknown })?.quantity;
        if (typeof id !== 'string' || !id.startsWith('gid://shopify/CartLine/')) {
          return { error: 'Invalid line id.' };
        }
        if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 1 || quantity > MAX_LINE_QTY) {
          return { error: `Quantity must be 1..${MAX_LINE_QTY}.` };
        }
        out.push({ id, quantity: Math.floor(quantity) });
      }
      return { op: { op: 'update', lines: out } };
    }
    case 'remove': {
      const lineIds = (body as { lineIds?: unknown }).lineIds;
      if (!Array.isArray(lineIds) || lineIds.length === 0 || lineIds.length > 50) {
        return { error: 'Field "lineIds" must be a non-empty array (max 50).' };
      }
      for (const id of lineIds) {
        if (typeof id !== 'string' || !id.startsWith('gid://shopify/CartLine/')) {
          return { error: 'Invalid line id.' };
        }
      }
      return { op: { op: 'remove', lineIds: lineIds as string[] } };
    }
    case 'buyNow': {
      const merchandiseId = (body as { merchandiseId?: unknown }).merchandiseId;
      const quantity = (body as { quantity?: unknown }).quantity;
      if (typeof merchandiseId !== 'string' || !merchandiseId.startsWith('gid://shopify/ProductVariant/')) {
        return { error: 'Invalid merchandiseId.' };
      }
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 1 || quantity > MAX_LINE_QTY) {
        return { error: `Quantity must be 1..${MAX_LINE_QTY}.` };
      }
      return { op: { op: 'buyNow', merchandiseId, quantity: Math.floor(quantity) } };
    }
    default:
      return { error: `Unknown op: ${op}` };
  }
}

// ─── Operation execution ─────────────────────────────────────────────

type ShopifyCreds = { domain: string; token: string };

type ExecuteResult = { status: number; payload: ProxyResponse; setCookies: string[] };

async function execute(op: ProxyOp, existingCartId: string | null, creds: ShopifyCreds): Promise<ExecuteResult> {
  switch (op.op) {
    case 'fetch': {
      if (!existingCartId) {
        return { status: 200, payload: { cart: null, userErrors: [] }, setCookies: [clearCountCookie()] };
      }
      const { cart, userErrors, status } = await runQuery(
        creds,
        CART_FETCH,
        { cartId: existingCartId },
        'cart',
      );
      if (status === 404 || (status === 200 && !cart && userErrors.length === 0)) {
        // Cart expired or deleted upstream. Clear cookies so next mutation creates fresh.
        return { status: 200, payload: { cart: null, userErrors: [] }, setCookies: clearCartCookies() };
      }
      return wrap(status, cart, userErrors, existingCartId);
    }

    case 'create': {
      const { cart, userErrors, status } = await runMutation(
        creds,
        CART_CREATE,
        { input: { lines: op.lines } },
        'cartCreate',
      );
      return wrap(status, cart, userErrors, cart?.id ?? null);
    }

    case 'add': {
      // No cart yet → either create one (if seedIfMissing) or error politely.
      if (!existingCartId) {
        if (!op.seedIfMissing) {
          return {
            status: 409,
            payload: { cart: null, userErrors: [{ field: null, message: 'No cart exists; pass seedIfMissing.' }] },
            setCookies: [],
          };
        }
        const { cart, userErrors, status } = await runMutation(
          creds,
          CART_CREATE,
          { input: { lines: op.lines } },
          'cartCreate',
        );
        return wrap(status, cart, userErrors, cart?.id ?? null);
      }
      const { cart, userErrors, status } = await runMutation(
        creds,
        CART_LINES_ADD,
        { cartId: existingCartId, lines: op.lines },
        'cartLinesAdd',
      );
      // If Shopify says the cart is gone, fall back to create.
      if (cartGoneError(userErrors)) {
        const { cart: created, userErrors: createErrors, status: createStatus } = await runMutation(
          creds,
          CART_CREATE,
          { input: { lines: op.lines } },
          'cartCreate',
        );
        return wrap(createStatus, created, createErrors, created?.id ?? null);
      }
      return wrap(status, cart, userErrors, existingCartId);
    }

    case 'update': {
      if (!existingCartId) {
        return {
          status: 409,
          payload: { cart: null, userErrors: [{ field: null, message: 'No cart to update.' }] },
          setCookies: [],
        };
      }
      const { cart, userErrors, status } = await runMutation(
        creds,
        CART_LINES_UPDATE,
        { cartId: existingCartId, lines: op.lines },
        'cartLinesUpdate',
      );
      return wrap(status, cart, userErrors, existingCartId);
    }

    case 'remove': {
      if (!existingCartId) {
        return { status: 200, payload: { cart: null, userErrors: [] }, setCookies: clearCartCookies() };
      }
      const { cart, userErrors, status } = await runMutation(
        creds,
        CART_LINES_REMOVE,
        { cartId: existingCartId, lineIds: op.lineIds },
        'cartLinesRemove',
      );
      return wrap(status, cart, userErrors, existingCartId);
    }

    case 'buyNow': {
      // Ephemeral cart — does NOT touch the user's cookie.
      const { cart, userErrors, status } = await runMutation(
        creds,
        CART_CREATE,
        { input: { lines: [{ merchandiseId: op.merchandiseId, quantity: op.quantity }] } },
        'cartCreate',
      );
      return {
        status,
        payload: { cart: null, userErrors, ephemeralCheckoutUrl: cart?.checkoutUrl ?? null },
        setCookies: [],
      };
    }
  }
}

function wrap(
  status: number,
  cart: ShopifyCart | null,
  userErrors: ShopifyUserError[],
  cartId: string | null,
): ExecuteResult {
  const setCookies: string[] = [];
  if (cart) {
    setCookies.push(setCartIdCookie(cart.id));
    setCookies.push(setCountCookie(cart.totalQuantity ?? 0));
  } else if (cartId === null) {
    // Mutation orphaned the cart somehow — clear cookies.
    setCookies.push(...clearCartCookies());
  }
  return { status, payload: { cart, userErrors }, setCookies };
}

function cartGoneError(userErrors: ShopifyUserError[]): boolean {
  return userErrors.some((e) => /cart .* (not found|does not exist|invalid)/i.test(e.message));
}

// ─── Shopify HTTP layer ──────────────────────────────────────────────

async function runMutation(
  creds: ShopifyCreds,
  query: string,
  variables: Record<string, unknown>,
  rootField: 'cartCreate' | 'cartLinesAdd' | 'cartLinesUpdate' | 'cartLinesRemove',
): Promise<{ cart: ShopifyCart | null; userErrors: ShopifyUserError[]; status: number }> {
  const { json, status } = await shopifyFetch(creds, query, variables);
  if (!json || status >= 500) return { cart: null, userErrors: [], status };
  if (json.errors?.length) {
    return {
      cart: null,
      userErrors: json.errors.map((e: { message: string }) => ({ field: null, message: e.message })),
      status: status === 200 ? 502 : status,
    };
  }
  const root = (json.data as { [k: string]: { cart: ShopifyCart | null; userErrors: ShopifyUserError[] } } | undefined)?.[rootField];
  if (!root) return { cart: null, userErrors: [], status: status === 200 ? 502 : status };
  return { cart: root.cart, userErrors: root.userErrors ?? [], status };
}

async function runQuery(
  creds: ShopifyCreds,
  query: string,
  variables: Record<string, unknown>,
  rootField: 'cart',
): Promise<{ cart: ShopifyCart | null; userErrors: ShopifyUserError[]; status: number }> {
  const { json, status } = await shopifyFetch(creds, query, variables);
  if (!json || status >= 500) return { cart: null, userErrors: [], status };
  if (json.errors?.length) {
    return {
      cart: null,
      userErrors: json.errors.map((e: { message: string }) => ({ field: null, message: e.message })),
      status: status === 200 ? 502 : status,
    };
  }
  const cart = (json.data as { cart?: ShopifyCart | null } | undefined)?.[rootField] ?? null;
  return { cart, userErrors: [], status };
}

async function shopifyFetch(
  creds: ShopifyCreds,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ json: { data?: unknown; errors?: { message: string }[] } | null; status: number }> {
  const url = `https://${creds.domain}/api/${SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': creds.token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        return { json: null, status: res.status };
      }
      const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
      return { json, status: res.status };
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      console.error('[api/cart] Shopify fetch failed', err);
      return { json: null, status: 502 };
    }
  }
  return { json: null, status: 502 };
}

// ─── Cookies + response helpers ──────────────────────────────────────

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCartIdCookie(id: string): string {
  return `${CART_ID_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function setCountCookie(count: number): string {
  return `${CART_COUNT_COOKIE}=${count}; Path=/; Max-Age=${COOKIE_MAX_AGE}; Secure; SameSite=Lax`;
}

function clearCartCookies(): string[] {
  return [
    `${CART_ID_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    `${CART_COUNT_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
  ];
}

function clearCountCookie(): string {
  return `${CART_COUNT_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}

function jsonResponse(status: number, body: ProxyResponse, setCookies: string[] = []): Response {
  const headers = new Headers(JSON_HEADERS);
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}
