import type { CartEvent } from './types';

// Pub-sub for cart events. Subscribers (GA4, Shopify Pixels, Klaviyo, etc.)
// attach here instead of the rest of the codebase sprinkling gtag calls.
// No provider is wired yet — adopt later by attaching a subscriber from Base.astro.

type Listener = (event: CartEvent) => void;

const listeners = new Set<Listener>();

export function onCartEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitCartEvent(event: CartEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error('[cart] analytics listener threw', err);
    }
  }
}
