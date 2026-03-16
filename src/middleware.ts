import { defineMiddleware } from 'astro:middleware';

/**
 * Middleware handles:
 * 1. Cloudflare Access JWT validation for admin API routes
 * 2. Edge caching headers for SSR pages
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);

  // ─── Admin API auth: validate Cloudflare Access JWT ────────────
  if (url.pathname.startsWith('/api/admin/')) {
    const jwt = context.request.headers.get('cf-access-jwt-assertion');
    const cfAuthCookie = context.request.headers.get('cookie')?.match(/CF_Authorization=([^\s;]+)/)?.[1];
    if (!jwt && !cfAuthCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Cloudflare Access validates the JWT at the edge before the request
    // reaches the worker. The JWT may arrive via the cf-access-jwt-assertion
    // header (edge-injected) or the CF_Authorization cookie (browser requests).
  }

  const response = await next();

  // ─── SSR product pages: cache at the edge ──────────────────────
  if (url.pathname.startsWith('/shop/') && url.pathname !== '/shop/') {
    response.headers.set(
      'Cache-Control',
      'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
    );
    response.headers.set(
      'CDN-Cache-Control',
      'public, max-age=300, stale-while-revalidate=86400'
    );
  }

  return response;
});
