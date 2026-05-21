import type { APIRoute } from 'astro';
import { getSession } from '@/lib/auth/session';

export const prerender = false;

const DEFAULT_WORKER = 'https://loyalty.soard.workers.dev';

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
    return new Response(JSON.stringify({ error: 'not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const base = env.LOYALTY_WORKER_URL ?? DEFAULT_WORKER;
  const upstream = await fetch(
    `${base}/api/customer/balance?customer_id=${encodeURIComponent(session.customerId)}`,
  );

  if (!upstream.ok) {
    const detail = await upstream.text();
    return new Response(
      JSON.stringify({ error: 'balance lookup failed', upstreamStatus: upstream.status, detail }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};
