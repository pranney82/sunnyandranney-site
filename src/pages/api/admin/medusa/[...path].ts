export const prerender = false;

import type { APIRoute } from 'astro';
import { json, readJson, requireRole } from '@/lib/admin-http';
import { MEDUSA_PATH, MedusaProblem, medusaFetch } from '@/lib/medusa-admin';

/**
 * The browser's way to Medusa's purchasing, warehouse and label routes. Managers
 * only. Every write is recorded under the signed-in person, whatever the page sent.
 */
export const ALL: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const method = context.request.method;
  if (method !== 'GET' && method !== 'POST') return json({ error: 'Only GET and POST' }, 405);
  const path = context.params.path ?? '';
  if (!MEDUSA_PATH.test(path)) return json({ error: 'Not found' }, 404);

  let body: Record<string, unknown> | undefined;
  if (method === 'POST') {
    const read = await readJson(context.request);
    if (!read) return json({ error: 'Send a JSON object' }, 400);
    body = { ...read, staff_id: admin.email };
  }

  try {
    const res = await medusaFetch(context.locals.runtime.env, path, {
      method,
      body,
      search: new URL(context.request.url).search,
    });
    const type = res.headers.get('content-type') ?? 'application/json';
    const text = await res.text();
    if (!res.ok && type.includes('json')) {
      const message = (() => {
        try {
          return (JSON.parse(text) as { message?: string }).message;
        } catch {
          return undefined;
        }
      })();
      return json({ error: message ?? `Medusa answered ${res.status}` }, res.status);
    }
    return new Response(text, { status: res.status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof MedusaProblem) return json({ error: err.message }, err.status);
    throw err;
  }
};
