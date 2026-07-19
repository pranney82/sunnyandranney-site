/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  addLines,
  boot,
  checkout,
  clearError,
  onCartEvent,
  removeLine,
  subscribe,
  updateLineQty,
  buyNow,
  type AddItem,
} from '@/lib/cart';
import { formatMoney, moneyAmount } from '@/lib/cart/money';
import type { CartSnapshot, DisplayLine } from '@/lib/cart/types';

// Single Preact island that owns the entire cart drawer + toast.
//
// Wrapped in <div transition:persist> by CartDrawer.astro so the island
// outlives view transitions. All cart state comes from cart.subscribe();
// no DOM-mediated state, no MutationObservers.

type ToastState = { id: number; title: string; image: string | null };

// Compatibility shape used by existing window.addToCart callers (PDP).
type LegacyProduct = {
  variantId: string;
  title: string;
  price: number | string;
  image?: string;
  handle?: string;
  variantTitle?: string;
};

declare global {
  interface Window {
    openCart?: () => void;
    closeCart?: () => void;
    addToCart?: (product: LegacyProduct, qty?: number) => void;
    showCartToast?: (title?: string, image?: string) => void;
    __cartQueue?: Array<{ product: LegacyProduct; qty: number }>;
    __SHOPIFY_CURRENCY?: string;
  }
}

const SHOP_CURRENCY = () =>
  (typeof window !== 'undefined' && window.__SHOPIFY_CURRENCY) || 'USD';

function legacyToAddItem(p: LegacyProduct, qty: number): AddItem {
  const priceAmount = typeof p.price === 'number' ? p.price.toFixed(2) : String(p.price ?? '0');
  return {
    merchandiseId: p.variantId,
    quantity: qty,
    productHandle: p.handle ?? '',
    productTitle: p.title ?? '',
    variantTitle: p.variantTitle ?? '',
    image: p.image ? { url: p.image, altText: p.title ?? null } : null,
    price: { amount: priceAmount, currencyCode: SHOP_CURRENCY() },
  };
}

export default function CartDrawer() {
  const [snap, setSnap] = useState<CartSnapshot | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutMsg, setCheckoutMsg] = useState<string | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Subscribe to cart store ──────────────────────────────────
  useEffect(() => {
    const unsub = subscribe((s) => setSnap(s));
    boot();
    return () => {
      unsub();
    };
  }, []);

  // ─── Surface errors from the store as an inline alert ──────────
  useEffect(() => {
    const unsub = onCartEvent((e) => {
      if (e.type === 'error' && isOpen) {
        // Auto-dismiss after 6s; user can dismiss explicitly via Retry too.
        const t = setTimeout(() => clearError(), 6000);
        return () => clearTimeout(t);
      }
      return undefined;
    });
    return () => unsub();
  }, [isOpen]);

  // ─── Global open/close + addToCart + showCartToast ─────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.openCart = () => setIsOpen(true);
    window.closeCart = () => setIsOpen(false);

    window.showCartToast = (title?: string, image?: string) => {
      if (!title) return;
      const id = Date.now();
      setToast({ id, title, image: image ?? null });
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => {
        setToast((cur) => (cur?.id === id ? null : cur));
      }, 2500);
      // Badge bounce on header cart badges
      ['cart-count', 'mobile-cart-count'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('bounce');
        void el.offsetWidth;
        el.classList.add('bounce');
      });
    };

    window.addToCart = (product, qty = 1) => {
      const item = legacyToAddItem(product, qty);
      void addLines([item]);
      window.showCartToast?.(product.title, product.image);
      setIsOpen(true);
    };

    // Drain any add-to-cart clicks that happened before this island hydrated
    // (the PDP button is interactive before hydration; without this the click
    // would show "Added!" but silently do nothing).
    const queue = window.__cartQueue;
    if (Array.isArray(queue) && queue.length) {
      window.__cartQueue = [];
      for (const { product, qty } of queue) window.addToCart!(product, qty);
    }

    return () => {
      window.openCart = undefined;
      window.closeCart = undefined;
      window.addToCart = undefined;
      window.showCartToast = undefined;
    };
  }, []);

  // ─── Body scroll lock + ESC + focus management ────────────────
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
      setTimeout(() => closeBtnRef.current?.focus(), 50);
    } else {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function') prev.focus();
      previousFocusRef.current = null;
    }

    const onKeydown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        setIsOpen(false);
      } else if (e.key === 'Tab' && drawerRef.current) {
        trapFocus(drawerRef.current, e);
      }
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [isOpen]);

  if (!snap) {
    // First paint before subscribe() resolves: still render shell so badges
    // exist for nav code that queries them. Hidden content avoids flicker.
    return <CartShell isOpen={false} onClose={() => setIsOpen(false)} drawerRef={drawerRef} closeBtnRef={closeBtnRef} />;
  }

  const itemsToRender = snap.lines.filter((l) => !l.isPendingRemove);
  const isEmpty = itemsToRender.length === 0;

  const handleCheckout = async () => {
    if (checkoutLoading) return;
    if (isEmpty) {
      setCheckoutMsg('Your cart is empty.');
      return;
    }
    setCheckoutLoading(true);
    setCheckoutMsg(null);
    const result = await checkout();
    if (result.url) {
      window.location.href = result.url;
      return;
    }
    setCheckoutLoading(false);
    setCheckoutMsg(result.error?.message ?? 'Unable to start checkout. Please refresh and try again.');
  };

  return (
    <>
      <div
        class="cart-overlay"
        aria-hidden={isOpen ? 'false' : 'true'}
        onClick={() => setIsOpen(false)}
      />
      <aside
        class="cart-drawer"
        role="dialog"
        aria-modal={isOpen ? 'true' : undefined}
        aria-hidden={isOpen ? 'false' : 'true'}
        aria-label="Shopping cart"
        // @ts-expect-error — `inert` is valid HTML, types lag in some setups
        inert={!isOpen ? '' : undefined}
        ref={drawerRef}
      >
        <div class="cart-drawer__header">
          <h3>
            Your Cart
            {snap.totalQuantity > 0 && (
              <span class="cart-drawer__count">{snap.totalQuantity}</span>
            )}
          </h3>
          <button
            class="cart-drawer__close"
            aria-label="Close cart"
            onClick={() => setIsOpen(false)}
            ref={closeBtnRef}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {!isEmpty && (
          <div class="cart-drawer__shipping">
            <p class="shipping-bar__text" style={{ textAlign: 'center' }}>
              Local pickup only — no shipping available
            </p>
          </div>
        )}

        {isEmpty ? (
          <div class="cart-drawer__empty">
            <svg
              class="cart-empty__icon"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={{ opacity: 0.35 }}
            >
              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 01-8 0" />
            </svg>
            <p>Your cart is empty</p>
            <a href="/shop/" class="btn btn--primary" style={{ marginTop: '1rem' }} onClick={() => setIsOpen(false)}>
              Start Shopping
            </a>
          </div>
        ) : (
          <>
            <div class="cart-drawer__items">
              {itemsToRender.map((line) => (
                <CartLine
                  key={line.key}
                  line={line}
                  onClose={() => setIsOpen(false)}
                  onIncrement={() => line.lineId && void updateLineQty(line.lineId, line.quantity + 1)}
                  onDecrement={() => line.lineId && line.quantity > 1 && void updateLineQty(line.lineId, line.quantity - 1)}
                  onRemove={() => line.lineId && void removeLine(line.lineId)}
                />
              ))}
            </div>
            <div class="cart-drawer__footer">
              <div class="cart-footer__row">
                <span>Subtotal</span>
                <span class="cart-footer__total">{formatMoney(snap.subtotal)}</span>
              </div>
              <p class="cart-footer__note">Taxes calculated at checkout · Free showroom pickup · Local delivery referral available</p>
              {(snap.lastError || checkoutMsg) && (
                <div class="cart-footer__alert" role="alert">
                  {checkoutMsg ?? snap.lastError?.message}
                </div>
              )}
              <button
                type="button"
                class={`btn btn--gold cart-footer__checkout${checkoutLoading ? ' cart-footer__checkout--loading' : ''}`}
                style={{ width: '100%', justifyContent: 'center' }}
                disabled={checkoutLoading}
                onClick={handleCheckout}
              >
                {checkoutLoading ? 'Redirecting…' : 'Proceed to Checkout'}
              </button>
              <div class="cart-footer__trust">
                <span>Secure checkout</span>
                <span class="cart-footer__trust-dot">·</span>
                <span>100% to charity</span>
              </div>
            </div>
          </>
        )}
      </aside>

      {/* Toast */}
      <div class={`cart-toast${toast ? ' cart-toast--visible' : ''}`} role="status" aria-live="polite">
        <svg class="cart-toast__check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <div class="cart-toast__text">
          <span class="cart-toast__title">{toast?.title ?? ''}</span>
          <span class="cart-toast__sub">Added to cart</span>
        </div>
      </div>
    </>
  );
}

// Shell shown when snapshot hasn't arrived yet — same chrome, no items.
function CartShell({
  isOpen,
  onClose,
  drawerRef,
  closeBtnRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  drawerRef: { current: HTMLDivElement | null };
  closeBtnRef: { current: HTMLButtonElement | null };
}) {
  return (
    <>
      <div class="cart-overlay" aria-hidden={isOpen ? 'false' : 'true'} onClick={onClose} />
      <aside
        class="cart-drawer"
        role="dialog"
        aria-modal={isOpen ? 'true' : undefined}
        aria-hidden={isOpen ? 'false' : 'true'}
        aria-label="Shopping cart"
        // @ts-expect-error inert
        inert={!isOpen ? '' : undefined}
        ref={drawerRef as { current: HTMLDivElement | null }}
      >
        <div class="cart-drawer__header">
          <h3>Your Cart</h3>
          <button class="cart-drawer__close" aria-label="Close cart" onClick={onClose} ref={closeBtnRef as { current: HTMLButtonElement | null }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </aside>
    </>
  );
}

function CartLine({
  line,
  onIncrement,
  onDecrement,
  onRemove,
  onClose,
}: {
  line: DisplayLine;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const productLink = `/shop/${encodeURIComponent(line.productHandle)}/`;
  const imageUrl = line.image?.url
    ? line.image.url.includes('cdn.shopify.com')
      ? `${line.image.url}${line.image.url.includes('?') ? '&' : '?'}width=160&crop=center`
      : line.image.url
    : null;
  const unavailable = !line.available;
  return (
    <div class={`cart-item${line.isOptimistic ? ' cart-item--optimistic' : ''}${unavailable ? ' cart-item--unavailable' : ''}`}>
      <a class="cart-item__image" href={productLink} onClick={onClose}>
        {imageUrl && <img src={imageUrl} alt={line.image?.altText ?? line.productTitle} loading="lazy" />}
      </a>
      <div class="cart-item__details">
        <a class="cart-item__title" href={productLink} onClick={onClose}>{line.productTitle}</a>
        {line.variantTitle && <div class="cart-item__variant">{line.variantTitle}</div>}
        {unavailable && (
          <div class="cart-item__variant" style={{ color: '#991B1B' }}>Currently unavailable</div>
        )}
        <div class="cart-item__bottom">
          <div class="cart-item__qty">
            <button
              aria-label="Decrease quantity"
              disabled={line.quantity <= 1 || !line.lineId}
              style={{ opacity: line.quantity <= 1 ? 0.3 : 1 }}
              onClick={onDecrement}
            >
              −
            </button>
            <span>{line.quantity}</span>
            <button aria-label="Increase quantity" disabled={!line.lineId} onClick={onIncrement}>+</button>
          </div>
          <div>
            <span class="cart-item__price">{formatMoney(line.lineTotal)}</span>
            {line.quantity > 1 && (
              <div class="cart-item__unit-price">{formatMoney(line.unitPrice)} each</div>
            )}
          </div>
        </div>
        <button class="cart-item__remove" disabled={!line.lineId} onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

// ─── Focus trap ──────────────────────────────────────────────────────

function trapFocus(container: HTMLElement, e: KeyboardEvent) {
  const focusable = container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Unused import guards — these are used via window globals dynamically
void buyNow;
void moneyAmount;
