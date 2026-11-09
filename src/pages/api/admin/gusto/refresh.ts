import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { liveGusto } from '@/lib/gusto/client.mjs';
import { syncEmployeesIfStale } from '@/lib/gusto/employees.mjs';
import { GustoError } from '@/lib/gusto/oauth.mjs';
import { refreshPay } from '@/lib/gusto/pay-sync.mjs';
import { addDays, isIsoDate, localDate } from '@/lib/time-clock/hours.mjs';

export const prerender = false;

/**
 * Brings in what changed in Gusto after a page has already shown what the
 * store's database has. The page re-renders only when `changed` is true.
 */
export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  const env = context.locals.runtime.env;
  const gusto = await liveGusto(env);
  if (!gusto.client) return json({ connected: false, changed: false });
  const db = dbOf(context);

  try {
    if (body?.what === 'staff') {
      const changed = await syncEmployeesIfStale(db, gusto.client, gusto.connection);
      return json({ connected: true, changed });
    }
    if (body?.what === 'pay') {
      const today = localDate(new Date().toISOString());
      const to = isIsoDate(body.to) ? (body.to as string) : today;
      const from = isIsoDate(body.from) ? (body.from as string) : addDays(to, -90);
      const { read, remaining } = await refreshPay(db, gusto.client, { from, to, today });
      return json({ connected: true, changed: read > 0, remaining });
    }
    return json({ error: 'Invalid request' }, 400);
  } catch (err) {
    if (!(err instanceof GustoError)) throw err;
    return json({ connected: true, changed: false, error: err.message });
  }
};
