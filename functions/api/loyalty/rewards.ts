interface Env {
  LOYALTY_WORKER_URL?: string;
}

const DEFAULT_WORKER = 'https://loyalty.soard.workers.dev';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const base = env.LOYALTY_WORKER_URL ?? DEFAULT_WORKER;
  const upstream = await fetch(`${base}/api/rewards`);
  if (!upstream.ok) {
    return Response.json(
      { error: 'rewards_lookup_failed', upstreamStatus: upstream.status },
      { status: 502 },
    );
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
};
