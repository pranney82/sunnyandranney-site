import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { isMonth, monthRecord, setFiled } from '@/lib/sales-tax/status.mjs';

export const prerender = false;

/** Marks a month filed with the Georgia Tax Center's confirmation number, or takes the mark off. Managers only. */
export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  const month = body?.month;
  if (!body || !isMonth(month) || typeof body.filed !== 'boolean') return json({ error: 'Invalid request' }, 400);

  const db = dbOf(context);
  const changed = await setFiled(db, month as string, {
    filed: body.filed,
    by: admin.email,
    confirmation: typeof body.confirmation === 'string' ? body.confirmation : null,
  });
  if (!changed) return json({ error: 'That month hasn’t been sent yet, so it can’t be marked filed.' }, 404);
  const record = await monthRecord(db, month as string);
  return json({ ok: true, filed: record?.filed ?? null });
};
