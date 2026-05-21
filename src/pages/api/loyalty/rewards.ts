import type { APIRoute } from 'astro';

export const prerender = false;

const DEFAULT_WORKER = 'https://loyalty.soard.workers.dev';

export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string | undefined> } }).runtime?.env
    ?? (process.env as Record<string, string | undefined>);

  const base = env.LOYALTY_WORKER_URL ?? DEFAULT_WORKER;
  const upstream = await fetch(`${base}/api/rewards`);
  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: 'rewards_lookup_failed', upstreamStatus: upstream.status }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
};
