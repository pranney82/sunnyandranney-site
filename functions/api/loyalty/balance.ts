import { getSession } from '../../_lib/session';

interface Env {
  SESSION_SECRET: string;
  LOYALTY_WORKER_URL?: string;
}

const DEFAULT_WORKER = 'https://loyalty.soard.workers.dev';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const session = await getSession(request, env.SESSION_SECRET);
  if (!session) {
    return Response.json({ error: 'not authenticated' }, { status: 401 });
  }

  const base = env.LOYALTY_WORKER_URL ?? DEFAULT_WORKER;
  const upstream = await fetch(
    `${base}/api/customer/balance?customer_id=${encodeURIComponent(session.customerId)}`,
  );

  if (!upstream.ok) {
    const detail = await upstream.text();
    return Response.json(
      { error: 'balance lookup failed', upstreamStatus: upstream.status, detail },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};
