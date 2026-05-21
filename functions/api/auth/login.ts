import {
  generatePendingAuth,
  pkceChallenge,
  buildAuthorizeUrl,
} from '../../_lib/oauth';
import { encryptSession, buildCookie, PENDING_COOKIE, PENDING_MAX_AGE } from '../../_lib/session';

interface Env {
  CUSTOMER_ACCOUNT_CLIENT_ID: string;
  SESSION_SECRET: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to'));

  const pending = generatePendingAuth(returnTo);
  const codeChallenge = await pkceChallenge(pending.codeVerifier);
  const authorizeUrl = buildAuthorizeUrl(env.CUSTOMER_ACCOUNT_CLIENT_ID, pending, codeChallenge);

  const pendingToken = await encryptSession(pending, env.SESSION_SECRET);

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
  // Only allow relative paths back into our own site
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/rewards';
  return raw;
}
