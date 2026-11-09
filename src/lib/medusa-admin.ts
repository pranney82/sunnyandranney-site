/**
 * The admin's line to the Medusa backend, where purchasing, receiving and the
 * warehouse live. Server-side only: the secret key never reaches a browser.
 * Pages call it while rendering, and the browser reaches it through
 * /api/admin/medusa/*, which adds who is acting.
 */

export interface MedusaEnv {
  MEDUSA_BACKEND_URL?: string;
  MEDUSA_ADMIN_KEY?: string;
}

/** Medusa answered with an error, or couldn't be reached. `message` is fit to show. */
export class MedusaProblem extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MedusaProblem';
  }
}

export function medusaConfigured(env: MedusaEnv): boolean {
  return Boolean(env.MEDUSA_BACKEND_URL && env.MEDUSA_ADMIN_KEY);
}

/** Only these parts of Medusa's admin API are reachable from the combined admin. */
export const MEDUSA_PATH = /^(purchasing|warehouse|labels|reports)(\/[A-Za-z0-9_\-]+)*\/?$/;

export async function medusaFetch(
  env: MedusaEnv,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; search?: string } = {},
): Promise<Response> {
  if (!medusaConfigured(env)) {
    throw new MedusaProblem('The admin isn’t connected to Medusa yet. Set MEDUSA_BACKEND_URL and MEDUSA_ADMIN_KEY.', 503);
  }
  if (!MEDUSA_PATH.test(path)) throw new MedusaProblem(`Not an admin path the admin may use: ${path}`, 400);
  const base = env.MEDUSA_BACKEND_URL!.replace(/\/+$/, '');
  // The site wants a trailing slash on every address; Medusa's routes have none.
  const url = `${base}/admin/${path.replace(/\/+$/, '')}${init.search ?? ''}`;
  try {
    return await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${env.MEDUSA_ADMIN_KEY}:`)}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new MedusaProblem(timedOut ? 'Medusa took too long to answer.' : 'Medusa can’t be reached right now.', 502);
  }
}

export async function medusaJson<T>(env: MedusaEnv, path: string, init: Parameters<typeof medusaFetch>[2] = {}): Promise<T> {
  const res = await medusaFetch(env, path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { message?: string } | null)?.message ?? `Medusa answered ${res.status}`;
    throw new MedusaProblem(message, res.status);
  }
  return body as T;
}
