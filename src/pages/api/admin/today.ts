import type { APIRoute } from 'astro';
import { json, requireRole } from '@/lib/admin-http';
import { liveGusto } from '@/lib/gusto/client.mjs';
import { GustoError } from '@/lib/gusto/oauth.mjs';
import { draftPayrolls, loadPlan, payrollToWorkOn } from '@/lib/gusto/send.mjs';
import { localDate } from '@/lib/time-clock/hours.mjs';

export const prerender = false;

/**
 * The next payroll and what's ready to send to it, for the Today page. Kept out
 * of the page itself so Gusto's response time never holds up what the store's
 * own database can show at once.
 */
export const GET: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const env = context.locals.runtime.env;
  const gusto = await liveGusto(env);
  if (!gusto.client) return json({ connected: false, reconnect: gusto.state === 'reconnect' });
  try {
    const today = localDate(new Date().toISOString());
    const drafts = await draftPayrolls(gusto.client, today);
    const next = payrollToWorkOn(drafts, today);
    let send = null;
    if (next && !gusto.readOnly) {
      const plan = await loadPlan(env.DB, gusto.client, next, admin.email);
      const people = new Set(plan.toSend.map((entry: { staff_id: string }) => entry.staff_id));
      send = {
        shifts: plan.toSend.length,
        people: people.size,
        minutes: plan.toSend.reduce(
          (sum: number, entry: { regularMinutes: number; overtimeMinutes: number }) => sum + entry.regularMinutes + entry.overtimeMinutes,
          0,
        ),
        alreadySent: plan.alreadySent,
        blockers: plan.blockers,
      };
    }
    return json({ connected: true, sendsHours: !gusto.readOnly, payroll: next, send });
  } catch (err) {
    if (!(err instanceof GustoError)) throw err;
    return json({ connected: true, error: err.message });
  }
};
