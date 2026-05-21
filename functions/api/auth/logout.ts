import { getSession, clearCookie, SESSION_COOKIE } from '../../_lib/session';
import { buildLogoutUrl, POST_LOGOUT_URI } from '../../_lib/oauth';

interface Env {
  SESSION_SECRET: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await getSession(request, env.SESSION_SECRET);

  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
  // Federated logout: send the customer through Shopify's logout endpoint so
  // their Customer Account session is also cleared, then back to our home.
  headers.set('Location', session?.idToken ? buildLogoutUrl(session.idToken) : POST_LOGOUT_URI);

  return new Response(null, { status: 302, headers });
};
