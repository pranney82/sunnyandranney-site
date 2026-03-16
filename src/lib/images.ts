// Shopify image resizing utility
// CF Image Resizing (/cdn-cgi/image/) is NOT supported on pages.dev domains —
// it requires a Cloudflare zone with Image Resizing (Business/Enterprise + custom domain).
// Shopify's own CDN handles resizing via ?width=xxx query params.

interface ImageOptions {
  width?: number;
  height?: number;
  quality?: number;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  gravity?: 'auto' | 'center' | 'top' | 'bottom' | 'left' | 'right';
  format?: 'auto' | 'avif' | 'webp' | 'json';
}

/**
 * Return a resized Shopify CDN URL using Shopify's native query params.
 * Works everywhere — no Cloudflare zone or plan required.
 */
export function cfImage(url: string, opts: ImageOptions = {}): string {
  if (!url) return url;

  const { width, height } = opts;

  if (url.includes('cdn.shopify.com')) {
    const params = new URLSearchParams();
    if (width) params.set('width', String(width));
    if (height) params.set('height', String(height));
    if (width || height) params.set('crop', 'center');
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${params.toString()}`;
  }

  return url;
}

/**
 * Generate a responsive srcset using CF Image Resizing.
 * Each width gets its own optimized variant with AVIF/WebP auto-negotiation.
 */
export function cfSrcset(url: string, widths: number[] = [300, 600, 900, 1200]): string {
  if (!url) return '';
  return widths.map(w => `${cfImage(url, { width: w })} ${w}w`).join(', ');
}

/**
 * Generate sizes attribute for common grid layouts.
 */
export const SIZES = {
  /** Shop grid card: 2-col mobile, 3-col tablet, 3-4 col desktop */
  gridCard: '(max-width: 639px) 50vw, (max-width: 1023px) 33vw, 25vw',
  /** PDP main image: full-width mobile, half desktop */
  pdpMain: '(max-width: 767px) 100vw, 50vw',
  /** Related/FBT card */
  related: '(max-width: 767px) 50vw, 25vw',
  /** Cart thumbnail */
  cartThumb: '80px',
  /** Quick view modal image */
  quickView: '(max-width: 639px) 92vw, 45vw',
} as const;
