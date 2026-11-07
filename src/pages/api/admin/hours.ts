import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { localInputToUtc, workedMinutes } from '@/lib/time-clock/hours.mjs';
import {
  addManualEntry,
  approveEntries,
  editEntry,
  rejectEntry,
  reopenEntry,
  type VersionedId,
} from '@/lib/time-clock/store';

export const prerender = false;

const MAX_SHIFT_MINUTES = 16 * 60;
const MAX_BATCH = 100;
const STALE =
  'This shift changed, overlaps another shift, or is your own. Reload and check it. Your own hours need another manager.';

function asVersioned(value: unknown): VersionedId | null {
  const item = value as Partial<VersionedId> | null;
  if (typeof item?.id !== 'string' || !Number.isInteger(item?.version)) return null;
  return { id: item.id, version: item.version as number };
}

function parseTimes(body: Record<string, unknown>): { clockInAt: string; clockOutAt: string } | string {
  const clockInAt = localInputToUtc(body.clockIn);
  const clockOutAt = localInputToUtc(body.clockOut);
  if (!clockInAt || !clockOutAt) return 'Enter a valid clock-in and clock-out time.';
  if (clockOutAt <= clockInAt) return 'Clock-out must be after clock-in.';
  if (Date.parse(clockOutAt) > Date.now()) return 'Clock-out cannot be in the future.';
  if (workedMinutes(clockInAt, clockOutAt) > MAX_SHIFT_MINUTES) return 'A shift cannot be longer than 16 hours.';
  return { clockInAt, clockOutAt };
}

function parseReason(body: Record<string, unknown>): string | null {
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  return reason.length >= 3 ? reason : null;
}

export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  if (!body) return json({ error: 'Invalid request' }, 400);

  const db = dbOf(context);
  const needReason = 'Add a short reason. It stays in the shift history.';

  switch (body.action) {
    case 'approve': {
      if (!Array.isArray(body.entries) || body.entries.length > MAX_BATCH) {
        return json({ error: 'Invalid request' }, 400);
      }
      const items = body.entries.map(asVersioned);
      if (items.some((item) => !item)) return json({ error: 'Invalid request' }, 400);
      const approved = await approveEntries(db, items as VersionedId[], admin.email);
      if (approved === 0 && items.length > 0) return json({ error: STALE }, 409);
      return json({ approved, skipped: items.length - approved });
    }

    case 'edit': {
      const item = asVersioned(body);
      const reason = parseReason(body);
      const times = parseTimes(body);
      if (!item || typeof body.staffId !== 'string') return json({ error: 'Invalid request' }, 400);
      if (typeof times === 'string') return json({ error: times }, 400);
      if (!reason) return json({ error: needReason }, 400);
      const ok = await editEntry(db, { ...item, staffId: body.staffId, ...times, reason }, admin.email);
      return ok ? json({ ok }) : json({ error: STALE }, 409);
    }

    case 'add': {
      const reason = parseReason(body);
      const times = parseTimes(body);
      if (typeof body.staffId !== 'string') return json({ error: 'Invalid request' }, 400);
      if (typeof times === 'string') return json({ error: times }, 400);
      if (!reason) return json({ error: needReason }, 400);
      const ok = await addManualEntry(db, { staffId: body.staffId, ...times, reason }, admin.email);
      return ok ? json({ ok }) : json({ error: STALE }, 409);
    }

    case 'reject': {
      const item = asVersioned(body);
      const reason = parseReason(body);
      if (!item) return json({ error: 'Invalid request' }, 400);
      if (!reason) return json({ error: needReason }, 400);
      const ok = await rejectEntry(db, { ...item, reason }, admin.email);
      return ok ? json({ ok }) : json({ error: STALE }, 409);
    }

    case 'reopen': {
      const item = asVersioned(body);
      if (!item || typeof body.staffId !== 'string') return json({ error: 'Invalid request' }, 400);
      const ok = await reopenEntry(db, { ...item, staffId: body.staffId }, admin.email);
      return ok ? json({ ok }) : json({ error: STALE }, 409);
    }

    default:
      return json({ error: 'Invalid request' }, 400);
  }
};
