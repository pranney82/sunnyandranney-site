import { moneyAmount, multiplyMoney, zeroMoney } from './money';
import type {
  CartError,
  CartSnapshot,
  CartState,
  DisplayLine,
  Money,
  PendingOp,
  ShopifyCart,
  ShopifyCartLine,
} from './types';

// State machine + selector for the cart.
//
// Why this exists: the previous implementation overwrote localStorage with
// every server response, so an in-flight remove could be undone by an
// unrelated mutation's response (the audit's flicker bugs).
//
// Here, server response → settle that mutation's pending op atomically,
// and the snapshot selector reconciles (server lines) + (still-pending ops).
// A remove that hasn't been confirmed by Shopify hides the line. An add that
// hasn't been confirmed shows an optimistic line. Update overrides the qty.

export type Action =
  | { type: 'OP_START'; op: PendingOp }
  | { type: 'OP_SETTLE'; opId: string; cart: ShopifyCart | null }
  | { type: 'OP_FAIL'; opId: string; error: CartError }
  | { type: 'CART_LOADED'; cart: ShopifyCart | null }
  | { type: 'STATUS'; status: CartState['status'] }
  | { type: 'ERROR'; error: CartError }
  | { type: 'CLEAR_ERROR' }
  | { type: 'CLEAR' };

export const initialState: CartState = {
  status: 'idle',
  cart: null,
  pending: [],
  lastError: null,
  hasLoaded: false,
};

export function reduce(state: CartState, action: Action): CartState {
  switch (action.type) {
    case 'OP_START': {
      return {
        ...state,
        status: 'syncing',
        pending: [...state.pending, action.op],
      };
    }
    case 'OP_SETTLE': {
      const pending = state.pending.filter((o) => o.id !== action.opId);
      const cart = action.cart ?? state.cart;
      return {
        ...state,
        cart,
        pending,
        status: pending.length === 0 ? (state.status === 'checking-out' ? 'checking-out' : 'idle') : 'syncing',
        lastError: null,
        hasLoaded: true,
      };
    }
    case 'OP_FAIL': {
      const pending = state.pending.filter((o) => o.id !== action.opId);
      return {
        ...state,
        pending,
        status: pending.length === 0 ? 'error' : 'syncing',
        lastError: action.error,
        hasLoaded: true,
      };
    }
    case 'CART_LOADED': {
      return {
        ...state,
        cart: action.cart,
        status: state.pending.length > 0 ? 'syncing' : 'idle',
        hasLoaded: true,
      };
    }
    case 'STATUS':
      return { ...state, status: action.status };
    case 'ERROR':
      return { ...state, status: 'error', lastError: action.error };
    case 'CLEAR_ERROR':
      return { ...state, lastError: null, status: state.pending.length > 0 ? 'syncing' : 'idle' };
    case 'CLEAR':
      return initialState;
  }
}

// ─── Selector: state → what the UI renders ───────────────────────────

export function selectSnapshot(state: CartState): CartSnapshot {
  const serverLines: ShopifyCartLine[] = state.cart?.lines.edges.map((e) => e.node) ?? [];
  const currencyCode =
    state.cart?.cost.subtotalAmount.currencyCode ??
    serverLines[0]?.cost.totalAmount.currencyCode ??
    'USD';

  // Index pending ops for quick lookups
  const pendingRemoveLineIds = new Set<string>();
  const pendingQty = new Map<string, number>();
  const pendingAdds: Extract<PendingOp, { kind: 'add' }>[] = [];
  for (const op of state.pending) {
    if (op.kind === 'remove') op.lineIds.forEach((id) => pendingRemoveLineIds.add(id));
    else if (op.kind === 'update') pendingQty.set(op.lineId, op.quantity);
    else if (op.kind === 'add') pendingAdds.push(op);
  }

  // Server lines with overrides (and pending-removes filtered)
  const lines: DisplayLine[] = [];
  let hasUnavailable = false;
  for (const line of serverLines) {
    if (pendingRemoveLineIds.has(line.id)) continue;
    const variant = line.merchandise;
    const overrideQty = pendingQty.get(line.id);
    const qty = overrideQty ?? line.quantity;
    const unitPrice = line.cost.amountPerQuantity ?? variant.price;
    const compareAt = line.cost.compareAtAmountPerQuantity ?? variant.compareAtPrice ?? null;
    const lineTotal = overrideQty !== undefined ? multiplyMoney(unitPrice, qty) : line.cost.totalAmount;
    if (!variant.availableForSale) hasUnavailable = true;
    lines.push({
      key: line.id,
      lineId: line.id,
      merchandiseId: variant.id,
      productHandle: variant.product.handle,
      productTitle: variant.product.title,
      variantTitle: normalizeVariantTitle(variant.title),
      image: variant.image ?? variant.product.featuredImage ?? null,
      unitPrice,
      compareAtUnitPrice: compareAt,
      lineTotal,
      quantity: qty,
      available: variant.availableForSale,
      isOptimistic: false,
      isPendingRemove: false,
      isPendingQty: overrideQty !== undefined,
    });
  }

  // Optimistic adds: dedup if a server line already represents this merchandise.
  // Heuristic: if a server line for the same merchandiseId exists AND its quantity
  // is >= the pending add's quantity, assume the add has been merged server-side
  // (race between optimistic state and the reducer settling). Otherwise show it.
  const serverByMerch = new Map<string, ShopifyCartLine>();
  for (const line of serverLines) serverByMerch.set(line.merchandise.id, line);

  for (const op of pendingAdds) {
    const serverLine = serverByMerch.get(op.merchandiseId);
    const alreadyRepresented =
      serverLine != null && serverLine.quantity >= op.quantity && !pendingRemoveLineIds.has(serverLine.id);
    if (alreadyRepresented) continue;
    const unitPrice = op.line.price;
    lines.push({
      key: `optimistic:${op.id}`,
      lineId: null,
      merchandiseId: op.merchandiseId,
      productHandle: op.line.productHandle,
      productTitle: op.line.productTitle,
      variantTitle: normalizeVariantTitle(op.line.variantTitle),
      image: op.line.image,
      unitPrice,
      compareAtUnitPrice: op.line.compareAtPrice,
      lineTotal: multiplyMoney(unitPrice, op.quantity),
      quantity: op.quantity,
      available: true,
      isOptimistic: true,
      isPendingRemove: false,
      isPendingQty: false,
    });
  }

  // Totals: prefer server subtotal when no pending ops affect quantities.
  let subtotal: Money;
  const totalQuantity = lines.reduce((n, l) => n + l.quantity, 0);
  if (state.pending.length === 0 && state.cart) {
    subtotal = state.cart.cost.subtotalAmount;
  } else {
    subtotal = {
      amount: lines.reduce((s, l) => s + moneyAmount(l.lineTotal), 0).toFixed(2),
      currencyCode,
    };
  }

  return {
    status: state.status,
    lines,
    totalQuantity,
    subtotal: subtotal ?? zeroMoney(currencyCode),
    currencyCode,
    checkoutUrl: state.cart?.checkoutUrl ?? null,
    hasUnavailable,
    lastError: state.lastError,
    hasLoaded: state.hasLoaded,
  };
}

function normalizeVariantTitle(title: string): string {
  if (!title) return '';
  return title === 'Default Title' ? '' : title;
}
