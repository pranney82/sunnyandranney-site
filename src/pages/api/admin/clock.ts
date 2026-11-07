import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { verifyPin } from '@/lib/time-clock/pin.mjs';
import { clockIn, clockOut, countPinAttempt, getStaff } from '@/lib/time-clock/store';

export const prerender = false;

const WRONG_PIN = 'That PIN did not match. Try again or ask a manager.';

export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager', 'kiosk');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  const staffId = body?.staffId;
  const pin = body?.pin;
  const action = body?.action;
  // The action is explicit, not a toggle, so a double tap can't clock someone
  // back out a moment after they clocked in.
  if (typeof staffId !== 'string' || typeof pin !== 'string' || (action !== 'in' && action !== 'out')) {
    return json({ error: 'Invalid request' }, 400);
  }

  const db = dbOf(context);
  const allowed = await countPinAttempt(db, `clock-pin:${staffId}`, 5, 300);
  if (!allowed) return json({ error: 'Too many tries. Wait five minutes, then try again.' }, 429);

  const staff = await getStaff(db, staffId);
  if (!staff || !staff.active || !(await verifyPin(pin, staff.pin_salt, staff.pin_hash))) {
    return json({ error: WRONG_PIN }, 403);
  }

  const at = action === 'in' ? await clockIn(db, staffId, admin.email) : await clockOut(db, staffId, admin.email);
  if (!at) {
    const message = action === 'in' ? 'You are already clocked in.' : 'You are not clocked in.';
    return json({ error: message }, 409);
  }
  return json({ name: staff.display_name, action, at });
};
