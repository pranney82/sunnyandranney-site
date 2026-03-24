/**
 * Durable Object that debounces Cloudflare Pages deploy hook calls.
 *
 * Any worker can poke the singleton instance via fetch. Each poke resets an
 * alarm into the future. When webhook activity settles and the alarm fires, a
 * single deploy is triggered. A max-wait cap ensures deploys can't be deferred
 * indefinitely by a stream of webhooks.
 */

interface Env {
  DEPLOY_COORDINATOR: DurableObjectNamespace;
  CF_DEPLOY_HOOK_URL?: string;
}

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes — deploy even if webhooks keep arriving

export class DeployCoordinator implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    const now = Date.now();

    // Record when the first poke in this cycle arrived
    let firstPoke = await this.state.storage.get<number>('firstPoke');
    if (!firstPoke) {
      firstPoke = now;
      await this.state.storage.put('firstPoke', firstPoke);
    }

    // If we've been deferring longer than MAX_WAIT_MS, deploy immediately
    const elapsed = now - firstPoke;
    const alarmTime = elapsed >= MAX_WAIT_MS
      ? now + 1000 // fire in 1s
      : now + DEBOUNCE_MS;

    await this.state.storage.setAlarm(alarmTime);
    return new Response(
      JSON.stringify({ debounced: true, willDeployAt: new Date(alarmTime).toISOString(), waitingSince: new Date(firstPoke).toISOString() }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  async alarm(): Promise<void> {
    // Clear the first-poke marker so the next cycle starts fresh
    await this.state.storage.delete('firstPoke');

    const hookUrl = this.env.CF_DEPLOY_HOOK_URL;
    if (!hookUrl) {
      console.error('[deploy-coordinator] CF_DEPLOY_HOOK_URL not set');
      return;
    }

    const res = await fetch(hookUrl, { method: 'POST' });
    if (!res.ok) {
      console.error(`[deploy-coordinator] Deploy hook returned ${res.status}`);
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
