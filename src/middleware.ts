import { defineMiddleware } from 'astro:middleware';

/**
 * Cloudflare edge caching middleware for SSR pages.
 * Static pages are already cached via _headers. This handles
 * server-rendered pages like /shop/[handle].
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  const url = new URL(context.request.url);

  // SSR product pages: cache at the edge for 5 min, serve stale for 1 hour
  if (url.pathname.startsWith('/shop/') && url.pathname !== '/shop/') {
    response.headers.set(
      'Cache-Control',
      'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
    );
    // CF-specific: cache at Cloudflare edge longer than browser
    response.headers.set(
      'CDN-Cache-Control',
      'public, max-age=300, stale-while-revalidate=86400'
    );
  }

  return response;
});
