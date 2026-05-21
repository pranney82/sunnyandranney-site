import type { APIRoute } from 'astro';
import { getSession } from '@/lib/auth/session';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string | undefined> } }).runtime?.env
    ?? (process.env as Record<string, string | undefined>);

  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    return new Response(JSON.stringify({ error: 'auth not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSession(request, sessionSecret);
  if (!session) {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({ authenticated: true, customerId: session.customerId, email: session.email ?? null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
