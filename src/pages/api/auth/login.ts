import type { APIRoute } from 'astro';
import {
  generatePendingAuth,
  pkceChallenge,
  buildAuthorizeUrl,
} from '@/lib/auth/oauth';
import {
  encryptSession,
  buildCookie,
  PENDING_COOKIE,
  PENDING_MAX_AGE,
} from '@/lib/auth/session';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string | undefined> } }).runtime?.env
    ?? (process.env as Record<string, string | undefined>);

  const clientId = env.CUSTOMER_ACCOUNT_CLIENT_ID;
  const sessionSecret = env.SESSION_SECRET;
  if (!clientId || !sessionSecret) {
    return new Response('auth not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to'));

  const pending = generatePendingAuth(returnTo);
  const codeChallenge = await pkceChallenge(pending.codeVerifier);
  const authorizeUrl = buildAuthorizeUrl(clientId, pending, codeChallenge);

  const pendingToken = await encryptSession(pending, sessionSecret);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      'Set-Cookie': buildCookie(PENDING_COOKIE, pendingToken, PENDING_MAX_AGE),
    },
  });
};

function sanitizeReturnTo(raw: string | null): string {
  if (!raw) return '/rewards';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/rewards';
  return raw;
}
