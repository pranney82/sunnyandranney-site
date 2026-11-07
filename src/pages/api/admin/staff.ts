import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { hashPin, PIN_RE } from '@/lib/time-clock/pin.mjs';
import { createStaff, updateStaff } from '@/lib/time-clock/store';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  if (!body) return json({ error: 'Invalid request' }, 400);

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const rawPin = typeof body.pin === 'string' ? body.pin.trim() : '';

  if (!name) return json({ error: 'Name is required.' }, 400);
  if (rawEmail && !EMAIL_RE.test(rawEmail)) return json({ error: 'That email does not look right.' }, 400);
  if (rawPin && !PIN_RE.test(rawPin)) return json({ error: 'PIN must be 4 to 8 digits.' }, 400);

  const pin = rawPin ? await hashPin(rawPin) : null;
  const email = rawEmail || null;
  const overtimeEligible = body.overtimeEligible === true;
  const db = dbOf(context);

  if (typeof body.id === 'string') {
    const ok = await updateStaff(db, body.id, {
      name,
      email,
      overtimeEligible,
      active: body.active === true,
      storeStaff: body.storeStaff === true,
      pin,
    });
    return ok ? json({ ok }) : json({ error: 'Employee not found.' }, 404);
  }

  await createStaff(db, { name, email, overtimeEligible, pin });
  return json({ ok: true });
};
