import {
  exchangeCodeForTokens,
  parseIdToken,
  type PendingAuth,
} from '../../_lib/oauth';
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
} from '../../_lib/session';

interface Env {
  CUSTOMER_ACCOUNT_CLIENT_ID: string;
  CUSTOMER_ACCOUNT_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
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

  const pending = await decryptSession<PendingAuth>(pendingToken, env.SESSION_SECRET);
  if (!pending) {
    return new Response('invalid pending auth cookie', { status: 400 });
  }
  if (pending.state !== state) {
    return new Response('state mismatch', { status: 403 });
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(
      env.CUSTOMER_ACCOUNT_CLIENT_ID,
      env.CUSTOMER_ACCOUNT_CLIENT_SECRET,
      code,
      pending.codeVerifier,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return new Response(`token exchange failed: ${msg}`, { status: 500 });
  }

  const claims = parseIdToken(tokens.id_token);
  if (claims.nonce !== pending.nonce) {
    return new Response('nonce mismatch', { status: 403 });
  }

  const session: SessionData = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
    customerId: claims.sub,
    email: claims.email,
  };

  const sessionToken = await encryptSession(session, env.SESSION_SECRET);

  const headers = new Headers();
  headers.set('Location', pending.returnTo || '/rewards');
  headers.append('Set-Cookie', buildCookie(SESSION_COOKIE, sessionToken, SESSION_MAX_AGE));
  headers.append('Set-Cookie', clearCookie(PENDING_COOKIE));

  return new Response(null, { status: 302, headers });
};
