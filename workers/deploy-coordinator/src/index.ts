/**
 * Durable Object that debounces Cloudflare Pages deploy hook calls.
 *
 * Any worker can poke the singleton instance via fetch. Each poke resets an
 * alarm 30 minutes into the future. When webhook activity settles and the
 * alarm fires, a single deploy is triggered. This eliminates the race
 * condition inherent in read-then-write debounce across concurrent Workers.
 */

interface Env {
  DEPLOY_COORDINATOR: DurableObjectNamespace;
  CF_DEPLOY_HOOK_URL?: string;
}

const DEBOUNCE_MS = 30 * 60 * 1000; // 30 minutes

export class DeployCoordinator implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    const alarmTime = Date.now() + DEBOUNCE_MS;
    await this.state.storage.setAlarm(alarmTime);
    return new Response(
      JSON.stringify({ debounced: true, willDeployAt: new Date(alarmTime).toISOString() }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  async alarm(): Promise<void> {
    const hookUrl = this.env.CF_DEPLOY_HOOK_URL;
    if (!hookUrl) {
      console.error('[deploy-coordinator] CF_DEPLOY_HOOK_URL not set');
      return;
    }

    const res = await fetch(hookUrl, { method: 'POST' });
    if (!res.ok) {
      console.error(`[deploy-coordinator] Deploy hook returned ${res.status}`);
      // Throwing causes Cloudflare to retry the alarm with exponential backoff
      throw new Error(`Deploy hook failed: ${res.status}`);
    }

    console.log('[deploy-coordinator] Deploy triggered');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405 });
    }

    const id = env.DEPLOY_COORDINATOR.idFromName('singleton');
    const stub = env.DEPLOY_COORDINATOR.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
