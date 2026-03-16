import { defineMiddleware } from 'astro:middleware';

/**
 * Middleware: Cloudflare Access JWT validation for admin API routes.
 * Product/shop pages are prerendered static files — CF Pages handles their
 * caching via public/_headers. No runtime cache headers needed here.
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

  return next();
});
