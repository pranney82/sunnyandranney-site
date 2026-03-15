// Cloudflare Image Resizing utility
// Routes images through CF's edge for AVIF/WebP auto-format, smart caching, and responsive transforms
// Uses /cdn-cgi/image/ which works on any Cloudflare-proxied domain
//
// Falls back to Shopify CDN resizing when CF Image Resizing is unavailable (local dev)

const SITE_DOMAIN = import.meta.env.SITE || 'https://sunnyandranney.com';
const USE_CF_IMAGES = import.meta.env.PROD !== false; // Enable in production

interface ImageOptions {
  width?: number;
  height?: number;
  quality?: number;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  gravity?: 'auto' | 'center' | 'top' | 'bottom' | 'left' | 'right';
  format?: 'auto' | 'avif' | 'webp' | 'json';
}

/**
 * Generate a Cloudflare Image Resizing URL.
 * In production, proxies any image URL through CF edge for:
 *   - Automatic AVIF/WebP based on Accept header
 *   - Edge caching (no origin round-trip after first request)
 *   - Consistent sizing and quality
 *
 * In dev, falls back to Shopify CDN params.
 */
export function cfImage(url: string, opts: ImageOptions = {}): string {
  if (!url) return url;

  const {
    width,
    height,
    quality = 80,
    fit = 'cover',
    gravity = 'auto',
    format = 'auto',
  } = opts;

  // In production, use CF Image Resizing
  if (USE_CF_IMAGES && url.includes('cdn.shopify.com')) {
    const parts: string[] = [];
    if (width) parts.push(`width=${width}`);
    if (height) parts.push(`height=${height}`);
    parts.push(`quality=${quality}`);
    parts.push(`fit=${fit}`);
    if (gravity !== 'center') parts.push(`gravity=${gravity}`);
    parts.push(`format=${format}`);

    return `${SITE_DOMAIN}/cdn-cgi/image/${parts.join(',')}/${url}`;
  }

  // Dev fallback: use Shopify CDN params
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
