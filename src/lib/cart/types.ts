// Cart types — modeled on Shopify Storefront API 2025-01.
// Hand-authored (not codegen'd) to keep zero build-time deps; structure
// matches the GraphQL fragment in queries.ts. Keep them in sync.

export type Money = {
  amount: string;
  currencyCode: string;
};

export type ShopifyImage = {
  url: string;
  altText: string | null;
};

export type ShopifyProductRef = {
  title: string;
  handle: string;
  featuredImage: ShopifyImage | null;
};

export type ShopifyVariant = {
  id: string;
  title: string;
  availableForSale: boolean;
  quantityAvailable: number | null;
  price: Money;
  compareAtPrice: Money | null;
  image: ShopifyImage | null;
  product: ShopifyProductRef;
};

export type ShopifyCartLine = {
  id: string;
  quantity: number;
  merchandise: ShopifyVariant;
  cost: {
    totalAmount: Money;
    amountPerQuantity: Money;
    compareAtAmountPerQuantity: Money | null;
  };
};

export type ShopifyCart = {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  cost: {
    subtotalAmount: Money;
    totalAmount: Money;
  };
  lines: { edges: Array<{ node: ShopifyCartLine }> };
};

export type ShopifyUserError = { field: string[] | null; message: string };

// ─── Optimistic state ────────────────────────────────────────────────
// Each pending op has a UUID so the reducer can settle/fail it atomically.
// Display logic uses the union of (server cart) + (pending optimistic ops),
// minus lines that have a pending remove. This is how items don't flicker.

export type OptimisticLine = {
  merchandiseId: string;
  productHandle: string;
  productTitle: string;
  variantTitle: string;
  image: ShopifyImage | null;
  price: Money;
  compareAtPrice: Money | null;
};

export type PendingOp =
  | { id: string; kind: 'add'; merchandiseId: string; quantity: number; line: OptimisticLine }
  | { id: string; kind: 'update'; lineId: string; quantity: number }
  | { id: string; kind: 'remove'; lineIds: string[] };

export type CartError = {
  code: 'network' | 'shopify' | 'unavailable' | 'qty_cap' | 'unknown';
  message: string;
  userErrors?: ShopifyUserError[];
};

export type CartStatus = 'idle' | 'syncing' | 'checking-out' | 'error';

export type CartState = {
  status: CartStatus;
  cart: ShopifyCart | null;
  pending: PendingOp[];
  lastError: CartError | null;
  // Whether the store has ever observed a real cart payload (sync or mutation).
  // Before this flips true, badge subscribers should defer to the pre-paint
  // cookie value rather than overwriting it with the empty initial snapshot.
  hasLoaded: boolean;
};

// ─── Display model (what the UI renders) ─────────────────────────────

export type DisplayLine = {
  key: string;                  // stable key (lineId or `optimistic:${opId}`)
  lineId: string | null;        // null while optimistic-only
  merchandiseId: string;
  productHandle: string;
  productTitle: string;
  variantTitle: string;         // '' for "Default Title"
  image: ShopifyImage | null;
  unitPrice: Money;
  compareAtUnitPrice: Money | null;
  lineTotal: Money;
  quantity: number;
  available: boolean;
  isOptimistic: boolean;
  isPendingRemove: boolean;     // line is on its way out
  isPendingQty: boolean;
};

export type CartSnapshot = {
  status: CartStatus;
  lines: DisplayLine[];
  totalQuantity: number;
  subtotal: Money;
  currencyCode: string;
  checkoutUrl: string | null;
  hasUnavailable: boolean;
  lastError: CartError | null;
  /** True after the store has observed a real cart from the server. */
  hasLoaded: boolean;
};

// ─── Public events (analytics + error notifications) ─────────────────

export type CartEvent =
  | { type: 'add_to_cart'; line: OptimisticLine; quantity: number; value: number; currency: string }
  | { type: 'remove_from_cart'; lineId: string; quantity: number }
  | { type: 'update_qty'; lineId: string; quantity: number }
  | { type: 'view_cart'; value: number; currency: string }
  | { type: 'begin_checkout'; value: number; currency: string }
  | { type: 'error'; error: CartError };

// ─── Proxy contract (POST /api/cart) ─────────────────────────────────
// `cartId` is NEVER sent in the request body — the server reads the
// httpOnly `sr_cart_id` cookie. Buy-Now uses ephemeral:true so the
// server doesn't touch that cookie.

export type CartProxyRequest =
  | { op: 'fetch' }
  | { op: 'add'; lines: Array<{ merchandiseId: string; quantity: number }>; seedIfMissing?: boolean }
  | { op: 'update'; lines: Array<{ id: string; quantity: number }> }
  | { op: 'remove'; lineIds: string[] }
  | { op: 'create'; lines: Array<{ merchandiseId: string; quantity: number }> }
  | { op: 'buyNow'; merchandiseId: string; quantity: number };

export type CartProxyResponse = {
  cart: ShopifyCart | null;
  userErrors: ShopifyUserError[];
  // For buyNow only — caller uses checkoutUrl directly, no cookie set.
  ephemeralCheckoutUrl?: string | null;
};
