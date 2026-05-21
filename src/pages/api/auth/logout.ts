import type { APIRoute } from 'astro';
import { getSession, clearCookie, SESSION_COOKIE } from '@/lib/auth/session';
import { buildLogoutUrl, POST_LOGOUT_URI } from '@/lib/auth/oauth';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string | undefined> } }).runtime?.env
    ?? (process.env as Record<string, string | undefined>);

  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    return new Response('auth not configured', { status: 500 });
  }

  const session = await getSession(request, sessionSecret);

  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
  // Federated logout — send the customer through Shopify's logout endpoint so
  // their Customer Account session is also cleared, then back to our home.
  headers.set('Location', session?.idToken ? buildLogoutUrl(session.idToken) : POST_LOGOUT_URI);

  return new Response(null, { status: 302, headers });
};
