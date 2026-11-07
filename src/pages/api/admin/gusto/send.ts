import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { liveGusto } from '@/lib/gusto/client.mjs';
import { GustoError } from '@/lib/gusto/oauth.mjs';
import { sendBatch } from '@/lib/gusto/send.mjs';
import { localDate } from '@/lib/time-clock/hours.mjs';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  const payrollUuid = typeof body?.payrollUuid === 'string' ? body.payrollUuid : '';
  if (!payrollUuid) return json({ error: 'Invalid request' }, 400);

  const gusto = await liveGusto(context.locals.runtime.env);
  if (!gusto.client) return json({ error: 'Gusto is not connected.' }, 409);
  if (gusto.readOnly) return json({ error: 'This connection only reads from Gusto.' }, 409);

  try {
    const result = await sendBatch(dbOf(context), gusto.client, {
      payrollUuid,
      actor: admin.email,
      today: localDate(new Date().toISOString()),
    });
    return result.blockers ? json({ error: 'This pay period is not ready.', blockers: result.blockers }, 409) : json(result);
  } catch (err) {
    if (err instanceof GustoError) return json({ error: err.message }, 502);
    throw err;
  }
};
