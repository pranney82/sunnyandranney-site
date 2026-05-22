import type { APIRoute } from 'astro';
import {
  exchangeCodeForTokens,
  parseIdToken,
  type PendingAuth,
} from '@/lib/auth/oauth';
import {
  encryptSession,
  decryptSession,
  buildCookie,
  clearCookie,
  readCookie,
  PENDING_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  type SessionData,
} from '@/lib/auth/session';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string | undefined> } }).runtime?.env
    ?? (process.env as Record<string, string | undefined>);

  const clientId = env.CUSTOMER_ACCOUNT_CLIENT_ID;
  const clientSecret = env.CUSTOMER_ACCOUNT_CLIENT_SECRET;
  const sessionSecret = env.SESSION_SECRET;
  if (!clientId || !clientSecret || !sessionSecret) {
    return new Response('auth not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response('missing code or state', { status: 400 });
  }

  const cookieHeader = request.headers.get('Cookie');
  const pendingToken = readCookie(cookieHeader, PENDING_COOKIE);
  if (!pendingToken) {
    return new Response('no pending auth session (cookie missing or expired)', { status: 400 });
  }

  const pending = await decryptSession<PendingAuth>(pendingToken, sessionSecret);
  if (!pending) {
    return new Response('invalid pending auth cookie', { status: 400 });
  }
  if (pending.state !== state) {
    return new Response('state mismatch', { status: 403 });
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(clientId, clientSecret, code, pending.codeVerifier);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return new Response(`token exchange failed: ${msg}`, { status: 500 });
  }

  const claims = parseIdToken(tokens.id_token);
  if (claims.nonce !== pending.nonce) {
    return new Response('nonce mismatch', { status: 403 });
  }

  // Shopify Customer Account API puts the bare numeric customer ID in `sub`
  // (sometimes serialized as a JSON number rather than a string), but the
  // Admin API GraphQL `customer(id: $id)` query requires the full GID format.
  const rawSub = String(claims.sub);
  const customerGid = rawSub.startsWith('gid://')
    ? rawSub
    : `gid://shopify/Customer/${rawSub}`;

  const session: SessionData = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
    customerId: customerGid,
    email: claims.email,
  };

  const sessionToken = await encryptSession(session, sessionSecret);

  const headers = new Headers();
  headers.set('Location', pending.returnTo || '/rewards');
  headers.append('Set-Cookie', buildCookie(SESSION_COOKIE, sessionToken, SESSION_MAX_AGE));
  headers.append('Set-Cookie', clearCookie(PENDING_COOKIE));

  return new Response(null, { status: 302, headers });
};
