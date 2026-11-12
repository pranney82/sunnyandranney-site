import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { check, clean, forKind, isSendDate, sendLabel } from '@/lib/sunny-side/special.mjs';
import { clearSpecial, putSpecial } from '@/lib/sunny-side/special-store.mjs';
import { STORE_TIME_ZONE, localDate } from '@/lib/time-clock/hours.mjs';

export const prerender = false;

const at = new Intl.DateTimeFormat('en-US', { timeZone: STORE_TIME_ZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const who = (email: string) => email.split('@')[0].replace(/^./, (c) => c.toUpperCase());

/** The send date from a request, or a response saying why it can't be changed. */
function sendOf(body: Record<string, unknown> | null): string | Response {
  const send = body?.send;
  if (!isSendDate(send)) return json({ error: 'Pick one of the Tuesday emails.' }, 400);
  if ((send as string) < localDate(new Date().toISOString())) return json({ error: `The ${sendLabel(send as string)} email has already gone out.` }, 409);
  return send as string;
}

function conflict(current: { updatedAt: string; updatedBy: string } | null | undefined) {
  const message = current
    ? `${who(current.updatedBy)} saved this week’s special at ${at.format(new Date(current.updatedAt))}. Reload to see it, then make your change again.`
    : 'This week’s special was cleared while you were editing. Reload, then save again.';
  return json({ error: message, current }, 409);
}

/** Saves the week's special. Managers only. */
export const PUT: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  const send = sendOf(body);
  if (send instanceof Response) return send;
  const since = body?.since;
  if (since !== null && typeof since !== 'string') return json({ error: 'Invalid request' }, 400);

  const special = clean(body?.special);
  const errors = check(special, send);
  if (Object.keys(errors).length) return json({ error: 'Some of the special needs fixing.', errors }, 422);

  const saved = await putSpecial(dbOf(context), { send, special: forKind(special), by: admin.email, now: new Date().toISOString(), since });
  if (!saved.ok) return conflict(saved.current);
  return json({ ok: true, updatedAt: saved.record!.updatedAt, updatedBy: saved.record!.updatedBy });
};

/** Takes the week's special away. Managers only. */
export const DELETE: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  const send = sendOf(body);
  if (send instanceof Response) return send;
  if (typeof body?.since !== 'string') return json({ error: 'Invalid request' }, 400);

  const cleared = await clearSpecial(dbOf(context), { send, since: body.since });
  if (!cleared.ok) return conflict(cleared.current);
  return json({ ok: true });
};
