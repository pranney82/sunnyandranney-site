/**
 * The filing page's two small helpers: a short confirmation at the bottom of the screen (screen readers hear it
 * too), and refreshing part of the page in place after a change. Kept with the sales tax code so the page needs
 * nothing from elsewhere in the admin.
 */

let region: HTMLElement | null = null;

/** A short confirmation at the bottom of the screen */
export function notify(message: string, tone: 'ok' | 'error' = 'ok'): void {
  if (!region) {
    region = document.createElement('div');
    region.className = 'sales-tax-notices';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    Object.assign(region.style, {
      position: 'fixed',
      left: '50%',
      bottom: 'calc(5.5rem + env(safe-area-inset-bottom, 0px))',
      transform: 'translateX(-50%)',
      display: 'grid',
      gap: '0.5rem',
      zIndex: '60',
      width: 'max-content',
      maxWidth: 'calc(100vw - 2rem)',
      pointerEvents: 'none',
    });
    document.body.appendChild(region);
  }
  const item = document.createElement('p');
  item.textContent = message;
  Object.assign(item.style, {
    margin: '0',
    padding: '0.75rem 1.125rem',
    borderRadius: '999px',
    background: tone === 'error' ? 'var(--red, #a12a1e)' : 'var(--ink, #2c2c2c)',
    color: '#fff',
    fontWeight: '600',
    fontSize: '0.9375rem',
    textAlign: 'center',
    boxShadow: 'var(--shadow, 0 18px 48px rgba(28, 27, 25, 0.22))',
    transition: 'opacity 0.3s ease',
  });
  region.appendChild(item);
  const stay = tone === 'error' ? 6000 : 3000;
  setTimeout(() => (item.style.opacity = '0'), stay);
  setTimeout(() => item.remove(), stay + 400);
}

/** Re-reads this page and swaps in fresh copies of the given parts. Buttons are bound by delegation, so they keep working. */
export async function refresh(...selectors: string[]): Promise<boolean> {
  try {
    const res = await fetch(location.href, { headers: { Accept: 'text/html' } });
    if (!res.ok) return false;
    const next = new DOMParser().parseFromString(await res.text(), 'text/html');
    const focusedId = document.activeElement?.id;
    for (const selector of selectors) {
      const now = document.querySelector(selector);
      const fresh = next.querySelector(selector);
      if (now && fresh) now.replaceWith(document.importNode(fresh, true));
    }
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}
