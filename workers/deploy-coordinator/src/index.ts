/**
 * Durable Object that debounces Cloudflare Pages deploy hook calls.
 *
 * Any worker can poke the singleton instance via fetch. Each poke resets an
 * alarm into the future. When webhook activity settles and the alarm fires, a
 * single deploy is triggered. A max-wait cap ensures deploys can't be deferred
 * indefinitely by a stream of webhooks.
 *
 * The deploy hook URL is stored in DO storage (not env) because DO alarm()
 * handlers don't reliably receive worker-level secrets.
 *
 * Auth:
 *   - Admin routes (/deploy, /set-hook, /status) require Authorization: Bearer <ADMIN_TOKEN>
 *   - Poke route (POST /) requires X-Poke-Secret header (shared with sync-products)
 *
 * Routes:
 *   POST /            — poke (reset debounce timer)
 *   POST /deploy      — force an immediate deploy, bypassing debounce [auth]
 *   POST /set-hook    — set the deploy hook URL in DO storage [auth]
 *   GET  /status      — return current debounce state [auth]
 */

interface Env {
  DEPLOY_COORDINATOR: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  POKE_SECRET?: string;
}

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes — deploy even if webhooks keep arriving
const HOOK_URL_KEY = 'hookUrl';
const ADMIN_ROUTES = ['/status', '/deploy', '/set-hook'];

export class DeployCoordinator implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status' && request.method === 'GET') {
      return this.status();
    }
    if (url.pathname === '/set-hook' && request.method === 'POST') {
      return this.setHook(request);
    }
    if (url.pathname === '/deploy' && request.method === 'POST') {
      return this.forceDeploy();
    }

    // Default: poke (debounce)
    return this.poke();
  }

  /** Store the deploy hook URL in durable storage. */
  private async setHook(request: Request): Promise<Response> {
    const { hookUrl } = await request.json<{ hookUrl: string }>();
    if (!hookUrl || typeof hookUrl !== 'string') {
      return Response.json({ error: 'hookUrl is required' }, { status: 400 });
    }
    await this.state.storage.put(HOOK_URL_KEY, hookUrl);
    console.log(`[deploy-coordinator] Hook URL set (${hookUrl.length} chars)`);
    return Response.json({ set: true, length: hookUrl.length });
  }

  /** Reset the debounce timer. If max-wait has elapsed, schedule immediately. */
  private async poke(): Promise<Response> {
    const now = Date.now();

    let firstPoke = await this.state.storage.get<number>('firstPoke');
    if (!firstPoke) {
      firstPoke = now;
      await this.state.storage.put('firstPoke', firstPoke);
    }

    const elapsed = now - firstPoke;
    const maxWaitReached = elapsed >= MAX_WAIT_MS;
    const alarmTime = maxWaitReached ? now + 1000 : now + DEBOUNCE_MS;

    await this.state.storage.setAlarm(alarmTime);

    const response = {
      debounced: true,
      maxWaitReached,
      willDeployAt: new Date(alarmTime).toISOString(),
      waitingSince: new Date(firstPoke).toISOString(),
      elapsedMs: elapsed,
    };

    console.log(`[deploy-coordinator] Poke received. maxWaitReached=${maxWaitReached}, alarm=${response.willDeployAt}, waiting since=${response.waitingSince}`);

    return Response.json(response);
  }

  /** Return current debounce state without modifying it. */
  private async status(): Promise<Response> {
    const firstPoke = await this.state.storage.get<number>('firstPoke');
    const alarm = await this.state.storage.getAlarm();
    const hookUrl = await this.state.storage.get<string>(HOOK_URL_KEY);

    return Response.json({
      hasHookUrl: !!hookUrl,
      hookUrlLength: hookUrl?.length ?? 0,
      firstPoke: firstPoke ? new Date(firstPoke).toISOString() : null,
      alarmScheduled: alarm ? new Date(alarm).toISOString() : null,
      now: new Date().toISOString(),
    });
  }

  /** Read the hook URL from durable storage. */
  private async getHookUrl(): Promise<string | undefined> {
    return this.state.storage.get<string>(HOOK_URL_KEY);
  }

  /** Bypass debounce and deploy immediately. */
  private async forceDeploy(): Promise<Response> {
    console.log('[deploy-coordinator] Force deploy requested');

    const hookUrl = await this.getHookUrl();
    if (!hookUrl) {
      const msg = 'Hook URL not set — call POST /set-hook first';
      console.error(`[deploy-coordinator] ${msg}`);
      return Response.json({ error: msg }, { status: 500 });
    }

    try {
      const res = await fetch(hookUrl, { method: 'POST' });
      const body = await res.text();

      if (!res.ok) {
        const msg = `Deploy hook returned ${res.status}: ${body}`;
        console.error(`[deploy-coordinator] ${msg}`);
        return Response.json({ error: msg }, { status: 502 });
      }

      // Clear debounce state since we just deployed
      await this.state.storage.delete('firstPoke');
      await this.state.storage.deleteAlarm();

      console.log('[deploy-coordinator] Force deploy triggered successfully');
      return Response.json({ deployed: true, hookStatus: res.status });
    } catch (err: any) {
      const msg = `Deploy hook fetch failed: ${err?.message}`;
      console.error(`[deploy-coordinator] ${msg}`);
      return Response.json({ error: msg }, { status: 502 });
    }
  }

  async alarm(): Promise<void> {
    const hookUrl = await this.getHookUrl();
    if (!hookUrl) {
      console.error('[deploy-coordinator] Hook URL not set — alarm fired with no hook URL configured');
      await this.state.storage.delete('firstPoke');
      return;
    }

    console.log('[deploy-coordinator] Alarm fired, calling deploy hook...');

    const res = await fetch(hookUrl, { method: 'POST' });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[deploy-coordinator] Deploy hook returned ${res.status}: ${body}`);
      // Throwing causes Cloudflare to retry the alarm with exponential backoff.
      // Do NOT clear firstPoke so the cycle stays intact during retries.
      throw new Error(`Deploy hook failed: ${res.status}`);
    }

    // Success — clear state so the next webhook starts a fresh cycle
    await this.state.storage.delete('firstPoke');
    console.log('[deploy-coordinator] Deploy triggered successfully');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // Route validation
    const isAdminRoute = ADMIN_ROUTES.includes(url.pathname);
    const isPokeRoute = url.pathname === '/';
    const allowed =
      (method === 'GET' && url.pathname === '/status') ||
      (method === 'POST' && (isPokeRoute || isAdminRoute));

    if (!allowed) {
      return new Response('Not found', { status: 404 });
    }

    // Admin routes require Bearer token auth
    if (isAdminRoute) {
      const adminToken = env.ADMIN_TOKEN;
      if (!adminToken) {
        return Response.json({ error: 'ADMIN_TOKEN not configured on worker' }, { status: 500 });
      }
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${adminToken}`) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // Poke route requires X-Poke-Secret header
    if (isPokeRoute) {
      const pokeSecret = env.POKE_SECRET;
      if (!pokeSecret) {
        return Response.json({ error: 'POKE_SECRET not configured on worker' }, { status: 500 });
      }
      const provided = request.headers.get('X-Poke-Secret');
      if (provided !== pokeSecret) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const id = env.DEPLOY_COORDINATOR.idFromName('singleton');
    const stub = env.DEPLOY_COORDINATOR.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
