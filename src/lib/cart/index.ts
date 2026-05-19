// Public entrypoint for the cart module.
// Consumers import from '@/lib/cart' or '@/lib/cart-store' (back-compat shim).

export * from './types';
export * from './store';
export { onCartEvent, emitCartEvent } from './analytics';
export { formatMoney, moneyAmount } from './money';
export { recentlyViewed } from './recently-viewed';
export type { RecentlyViewedItem } from './recently-viewed';
