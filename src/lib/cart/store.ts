import { emitCartEvent } from './analytics';
import { moneyAmount } from './money';
import { initialState, reduce, selectSnapshot, type Action } from './state';
import type {
  CartError,
  CartSnapshot,
  CartState,
  OptimisticLine,
  PendingOp,
  ShopifyCart,
  ShopifyUserError,
} from './types';

// Cart store — single source of truth on the client.
//
// Design choices:
//  • State lives in-memory; server cart identity lives in the httpOnly
//    `sr_cart_id` cookie set by /api/cart. We never store cartId in JS.
//  • The visible count for first-paint badges comes from the `sr_cart_n`
//    cookie set alongside it (non-httpOnly).
//  • Every mutation gets a UUID and goes through dispatch(). The reducer
//    atomically settles the op + applies the server cart, so reconcile
//    never undoes a still-in-flight remove (the audit's flicker class).
//  • All listeners receive a stable CartSnapshot — no DOM-mediated state.

export const QTY_CAP = 20;

let state: CartState = initialState;
const listeners = new Set<(snap: CartSnapshot) => void>();
let snapshotCache: CartSnapshot | null = null;
let booted = false;

function dispatch(action: Action) {
  state = reduce(state, action);
  snapshotCache = null;
  const snap = getSnapshot();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch (err) {
      console.error('[cart] listener threw', err);
    }
  }
}

function getSnapshot(): CartSnapshot {
  if (!snapshotCache) snapshotCache = selectSnapshot(state);
  return snapshotCache;
}

// ─── Public subscription API ─────────────────────────────────────────

export function subscribe(fn: (snap: CartSnapshot) => void): () => void {
  listeners.add(fn);
  fn(getSnapshot());
  return () => {
    listeners.delete(fn);
  };
}

export function getState(): CartSnapshot {
  return getSnapshot();
}

// ─── Network layer ───────────────────────────────────────────────────

type ProxyOp =
  | { op: 'fetch' }
  | { op: 'create'; lines: Array<{ merchandiseId: string; quantity: number }> }
  | { op: 'add'; lines: Array<{ merchandiseId: string; quantity: number }>; seedIfMissing?: boolean }
  | { op: 'update'; lines: Array<{ id: string; quantity: number }> }
  | { op: 'remove'; lineIds: string[] }
  | { op: 'buyNow'; merchandiseId: string; quantity: number };

type ProxyResult = {
  cart: ShopifyCart | null;
  userErrors: ShopifyUserError[];
  ephemeralCheckoutUrl?: string | null;
  ok: boolean;
  status: number;
};

async function callProxy(body: ProxyOp, signal?: AbortSignal): Promise<ProxyResult> {
  try {
    const res = await fetch('/api/cart/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
    let json: { cart?: ShopifyCart | null; userErrors?: ShopifyUserError[]; ephemeralCheckoutUrl?: string | null } = {};
    try {
      json = await res.json();
    } catch {
      // Non-JSON response — surface as a generic error.
    }
    return {
      cart: json.cart ?? null,
      userErrors: json.userErrors ?? [],
      ephemeralCheckoutUrl: json.ephemeralCheckoutUrl ?? null,
      ok: res.ok,
      status: res.status,
    };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    return { cart: null, userErrors: [], ok: false, status: 0 };
  }
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function shopifyError(userErrors: ShopifyUserError[]): CartError {
  return {
    code: userErrors.some((e) => /availab|sold out|inventory/i.test(e.message)) ? 'unavailable' : 'shopify',
    message: userErrors.map((e) => e.message).join('; ') || 'Shopify rejected the operation.',
    userErrors,
  };
}

function networkError(status: number): CartError {
  return {
    code: 'network',
    message:
      status === 0
        ? 'Network error talking to the cart service.'
        : `Cart service returned ${status}.`,
  };
}

// ─── Mutations ───────────────────────────────────────────────────────

export type AddItem = {
  merchandiseId: string;
  quantity: number;
  productHandle: string;
  productTitle: string;
  variantTitle: string;
  image: { url: string; altText: string | null } | null;
  price: { amount: string; currencyCode: string };
  compareAtPrice?: { amount: string; currencyCode: string } | null;
};

// Add one or more lines in a single Shopify call. Items targeting the
// same merchandiseId in one call are kept distinct in the optimistic
// state and merged server-side as a single line on response.
export async function addLines(items: AddItem[]): Promise<void> {
  if (items.length === 0) return;

  type AddOp = Extract<PendingOp, { kind: 'add' }>;
  const ops: AddOp[] = items.map((item) => {
    const quantity = clampQty(item.quantity);
    const optimistic: OptimisticLine = {
      merchandiseId: item.merchandiseId,
      productHandle: item.productHandle,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      image: item.image,
      price: item.price,
      compareAtPrice: item.compareAtPrice ?? null,
    };
    return {
      id: uuid(),
      kind: 'add',
      merchandiseId: item.merchandiseId,
      quantity,
      line: optimistic,
    };
  });

  for (const op of ops) {
    dispatch({ type: 'OP_START', op });
    emitCartEvent({
      type: 'add_to_cart',
      line: op.line,
      quantity: op.quantity,
      value: moneyAmount(op.line.price) * op.quantity,
      currency: op.line.price.currencyCode,
    });
  }

  const result = await callProxy({
    op: 'add',
    lines: ops.map((op) => ({ merchandiseId: op.merchandiseId, quantity: op.quantity })),
    seedIfMissing: true,
  });

  applyMutationResult(ops.map((o) => o.id), result);
}

export async function updateLineQty(lineId: string, quantity: number): Promise<void> {
  const next = clampQty(quantity);
  const op: PendingOp = { id: uuid(), kind: 'update', lineId, quantity: next };
  dispatch({ type: 'OP_START', op });
  emitCartEvent({ type: 'update_qty', lineId, quantity: next });

  const result = await callProxy({ op: 'update', lines: [{ id: lineId, quantity: next }] });
  applyMutationResult([op.id], result);
}

export async function removeLine(lineId: string): Promise<void> {
  const op: PendingOp = { id: uuid(), kind: 'remove', lineIds: [lineId] };
  dispatch({ type: 'OP_START', op });
  emitCartEvent({ type: 'remove_from_cart', lineId, quantity: 0 });

  const result = await callProxy({ op: 'remove', lineIds: [lineId] });
  applyMutationResult([op.id], result);
}

export async function clear(): Promise<void> {
  const snap = getSnapshot();
  const lineIds = snap.lines.map((l) => l.lineId).filter((id): id is string => !!id);
  if (lineIds.length === 0) {
    dispatch({ type: 'CLEAR' });
    return;
  }
  const op: PendingOp = { id: uuid(), kind: 'remove', lineIds };
  dispatch({ type: 'OP_START', op });
  const result = await callProxy({ op: 'remove', lineIds });
  applyMutationResult([op.id], result);
}

// One-shot fetch — used on boot to hydrate from the existing cookie cart.
export async function sync(): Promise<void> {
  dispatch({ type: 'STATUS', status: 'syncing' });
  const result = await callProxy({ op: 'fetch' });
  if (!result.ok) {
    dispatch({ type: 'ERROR', error: networkError(result.status) });
    return;
  }
  if (result.userErrors.length > 0) {
    dispatch({ type: 'ERROR', error: shopifyError(result.userErrors) });
    emitCartEvent({ type: 'error', error: shopifyError(result.userErrors) });
    return;
  }
  dispatch({ type: 'CART_LOADED', cart: result.cart });
}

// Checkout — never trusts a cached URL. Refetches the cart (forcing the
// cookie cart's checkoutUrl to be fresh), then navigates. Has a 12s wall
// clock so the user is never stuck on "Redirecting…" forever.
export async function checkout(): Promise<{ url: string | null; error: CartError | null }> {
  dispatch({ type: 'STATUS', status: 'checking-out' });
  emitCartEvent({
    type: 'begin_checkout',
    value: moneyAmount(getSnapshot().subtotal),
    currency: getSnapshot().currencyCode,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const result = await callProxy({ op: 'fetch' }, controller.signal);
    clearTimeout(timer);
    if (!result.ok || !result.cart) {
      const err = !result.ok ? networkError(result.status) : { code: 'unknown' as const, message: 'No cart returned.' };
      dispatch({ type: 'ERROR', error: err });
      return { url: null, error: err };
    }
    dispatch({ type: 'CART_LOADED', cart: result.cart });
    return { url: result.cart.checkoutUrl, error: null };
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string })?.name === 'AbortError') {
      const e: CartError = { code: 'network', message: 'Checkout timed out. Please try again.' };
      dispatch({ type: 'ERROR', error: e });
      return { url: null, error: e };
    }
    const e: CartError = { code: 'unknown', message: 'Unexpected error preparing checkout.' };
    dispatch({ type: 'ERROR', error: e });
    return { url: null, error: e };
  }
}

export async function buyNow(merchandiseId: string, quantity: number): Promise<string | null> {
  const result = await callProxy({ op: 'buyNow', merchandiseId, quantity: clampQty(quantity) });
  return result.ephemeralCheckoutUrl ?? null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function applyMutationResult(opIds: string[], result: ProxyResult) {
  if (!result.ok) {
    const err = networkError(result.status);
    for (const id of opIds) dispatch({ type: 'OP_FAIL', opId: id, error: err });
    emitCartEvent({ type: 'error', error: err });
    return;
  }
  if (result.userErrors.length > 0) {
    const err = shopifyError(result.userErrors);
    // We still settle the ops against the (possibly-partial) cart Shopify gave us
    // so the local state matches the server. Then emit the error so the UI can show it.
    for (const id of opIds) dispatch({ type: 'OP_SETTLE', opId: id, cart: result.cart });
    dispatch({ type: 'ERROR', error: err });
    emitCartEvent({ type: 'error', error: err });
    return;
  }
  for (const id of opIds) dispatch({ type: 'OP_SETTLE', opId: id, cart: result.cart });
}

export function clampQty(qty: number): number {
  if (!Number.isFinite(qty) || qty < 1) return 1;
  return Math.min(Math.floor(qty), QTY_CAP);
}

export function clearError() {
  dispatch({ type: 'CLEAR_ERROR' });
}

// ─── Boot ────────────────────────────────────────────────────────────
// Called once per page load. Idempotent. Reads the `sr_cart_n` cookie
// to know whether to hit the server (if 0, skip the network call).

export function boot(): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  const n = readCountCookie();
  if (n > 0) {
    // Fire and forget — listeners will get the update via dispatch.
    void sync();
  }
}

function readCountCookie(): number {
  if (typeof document === 'undefined') return 0;
  const m = document.cookie.match(/(?:^|;\s*)sr_cart_n=(\d+)/);
  return m ? parseInt(m[1], 10) || 0 : 0;
}
