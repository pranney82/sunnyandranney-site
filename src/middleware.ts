import { defineMiddleware } from 'astro:middleware';
import { authenticate } from '@/lib/admin-auth';
import { adminHostRedirect } from '@/lib/admin-host.mjs';

// Case-insensitive so a route can't be reached around this check by changing
// the case of the URL. Handlers also call requireRole, as a second gate.
const ADMIN_PATH = /^\/(api\/)?admin(\/|$)/i;

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    // Images may also come from the store's own Cloudflare Images account (the logo).
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function deny(isApi: boolean, status: number, message: string): Response {
  const headers = new Headers(SECURITY_HEADERS);
  if (isApi) {
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(message, { status, headers });
}

export const onRequest = defineMiddleware(async (context, next) => {
  if (!context.isPrerendered) {
    const elsewhere = adminHostRedirect(context.url, context.request.method);
    if (elsewhere) return context.redirect(elsewhere, 302);
  }

  const path = decodedPath(context.url.pathname);
  if (context.isPrerendered || !ADMIN_PATH.test(path)) return next();

  const isApi = path.toLowerCase().startsWith('/api/');
  const identity = await authenticate(context.request, context.locals.runtime?.env ?? {});
  if (!identity) return deny(isApi, 403, 'Not authorized');

  const method = context.request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    if (context.request.headers.get('origin') !== context.url.origin) {
      return deny(isApi, 403, 'Cross-site request refused');
    }
  }

  context.locals.admin = identity;
  const response = await next();

  // _headers only covers static assets on Pages, so set these here.
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
});
