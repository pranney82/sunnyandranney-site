import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { saveTaxCenterLogin } from '@/lib/sales-tax/status.mjs';

export const prerender = false;

/** Saves the store's Georgia Tax Center username, sales tax number and who gets the two-step code. Never the password. Managers only. */
export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  if (!body) return json({ error: 'Invalid request' }, 400);
  const saved = await saveTaxCenterLogin(dbOf(context), { username: body.username, stn: body.stn, codeNote: body.codeNote, by: admin.email });
  return 'error' in saved ? json({ error: saved.error }, 400) : json({ ok: true });
};
