import type { APIRoute } from 'astro';
import { dbOf, json, readJson, requireRole } from '@/lib/admin-http';
import { daysBetween, MAX_NOTE, TIME_OFF_KINDS, validateCell } from '@/lib/schedule/core.mjs';
import {
  addToSchedule,
  applyChanges,
  createScheduledPerson,
  isDate,
  knownStaff,
  loadWeek,
  moveOnSchedule,
  publishWeek,
  removeFromSchedule,
  resetCalendarToken,
  setDay,
  setTimeOffRange,
  setWeekNote,
  StaleError,
  stampsFor,
  type Cell,
  type Change,
  type TimeOff,
} from '@/lib/schedule/store';
import {
  connectWebhook,
  removeTextSignup,
  retryTexts,
  saveTextSignup,
  sendWeekTexts,
  SignupError,
} from '@/lib/schedule/texting';
import { isIsoDate, localDate, workweekStart } from '@/lib/time-clock/hours.mjs';

export const prerender = false;

/** A week of cells for a whole team, with room to spare. */
const MAX_CHANGES = 400;
const MAX_TIME_OFF_DAYS = 120;
const ACTIONS = new Set(['type', 'paste', 'move', 'copy', 'copy-week', 'clear', 'undo', 'redo', 'pick', 'resolve']);

function weekOf(value: unknown): string | null {
  return typeof value === 'string' && isIsoDate(value) ? workweekStart(value) : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
}

export const GET: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager', 'kiosk');
  if (admin instanceof Response) return admin;
  const week = weekOf(context.url.searchParams.get('week'));
  if (!week) return json({ error: 'Invalid week' }, 400);
  const textsReady = Boolean(context.locals.runtime.env.SENT_DM_API_KEY);
  return json(await loadWeek(dbOf(context), week, { readOnly: admin.role !== 'manager', textsReady }));
};

export const POST: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const body = await readJson(context.request);
  const week = weekOf(body?.week);
  if (!body || !week) return json({ error: 'Invalid request' }, 400);

  const db = dbOf(context);
  const env = context.locals.runtime.env;
  const actor = admin.email;
  const fresh = async (extra: Record<string, unknown> = {}, status = 200) =>
    json({ ...extra, state: await loadWeek(db, week, { readOnly: false, textsReady: Boolean(env.SENT_DM_API_KEY) }) }, status);

  try {
    switch (body.action) {
      case 'apply': {
        const reason = typeof body.reason === 'string' && ACTIONS.has(body.reason) ? body.reason : 'type';
        if (!Array.isArray(body.changes) || body.changes.length === 0 || body.changes.length > MAX_CHANGES) {
          return json({ error: 'Invalid request' }, 400);
        }
        const changes: Change[] = [];
        const seen = new Set<string>();
        for (const raw of body.changes as Array<Record<string, unknown>>) {
          const value = validateCell(raw?.value);
          const expect = raw?.expect as { s?: unknown; o?: unknown } | undefined;
          if (typeof value === 'string') return json({ error: value }, 400);
          if (typeof raw.staffId !== 'string' || !isIsoDate(raw.date as string)) return json({ error: 'Invalid request' }, 400);
          if (typeof expect?.s !== 'string' || typeof expect?.o !== 'string') return json({ error: 'Invalid request' }, 400);
          const key = `${raw.staffId}|${raw.date}`;
          if (seen.has(key)) return json({ error: 'Invalid request' }, 400);
          seen.add(key);
          changes.push({
            staffId: raw.staffId,
            date: raw.date as string,
            value: value as Cell,
            expect: { s: expect.s, o: expect.o },
          });
        }
        const known = await knownStaff(db, changes.map((c) => c.staffId));
        if (changes.some((c) => !known.has(c.staffId))) return json({ error: 'Someone on this change isn’t on staff.' }, 400);
        await applyChanges(db, changes, actor, reason);
        return fresh({ stamps: await stampsFor(db, changes) });
      }

      case 'timeOff': {
        const { staffId, from, to } = body;
        const clear = body.clear === true;
        const note = text(body.note ?? '', MAX_NOTE);
        if (typeof staffId !== 'string' || !isDate(from) || !isDate(to) || note === null) {
          return json({ error: 'Invalid request' }, 400);
        }
        if (!isIsoDate(from) || !isIsoDate(to) || to < from) return json({ error: 'The last day has to be on or after the first.' }, 400);
        if (daysBetween(from, to) >= MAX_TIME_OFF_DAYS) return json({ error: 'Time off can cover up to 120 days at once.' }, 400);
        if (!clear && !TIME_OFF_KINDS.includes(body.kind as string)) return json({ error: 'Invalid request' }, 400);
        if (!(await knownStaff(db, [staffId])).has(staffId)) return json({ error: 'Invalid request' }, 400);
        const undo = await setTimeOffRange(
          db,
          {
            staffId,
            from,
            to,
            off: clear ? null : { kind: body.kind as TimeOff['kind'], note },
            removeShifts: body.removeShifts === true,
          },
          actor,
        );
        return fresh({ undo, stamps: await stampsFor(db, undo) });
      }

      case 'day': {
        const note = text(body.note ?? '', MAX_NOTE);
        if (!isDate(body.date) || !isIsoDate(body.date) || note === null) return json({ error: 'Invalid request' }, 400);
        await setDay(db, { date: body.date, note, closed: body.closed === true }, actor);
        return fresh();
      }

      case 'weekNote': {
        const note = text(body.note ?? '', 1000);
        if (note === null) return json({ error: 'Keep the week’s note under 1,000 characters.' }, 400);
        await setWeekNote(db, week, note, actor);
        return fresh();
      }

      case 'publish': {
        await publishWeek(db, week, actor);
        // The week is published whatever sent.dm says; a text that fails is
        // shown on the page and goes again on the next publish.
        const texts = await sendWeekTexts(db, env, { weekStart: week, actor });
        return fresh({ texts });
      }

      case 'textSignup': {
        const staffId = typeof body.staffId === 'string' ? body.staffId : '';
        if (body.remove === true) {
          await removeTextSignup(db, staffId);
          return fresh();
        }
        if (typeof body.phone !== 'string' || typeof body.signedOn !== 'string' || body.consent !== true) {
          return json({ error: 'Add their number and the date on their signed form.' }, 400);
        }
        try {
          const result = await saveTextSignup(
            db,
            env,
            { staffId, phone: body.phone, signedOn: body.signedOn, today: localDate(new Date().toISOString()) },
            actor,
          );
          return fresh(result);
        } catch (err) {
          if (err instanceof SignupError) return json({ error: err.message }, 400);
          throw err;
        }
      }

      case 'textRetry': {
        const staffId = typeof body.staffId === 'string' ? body.staffId : '';
        return fresh(await retryTexts(db, env, { weekStart: week, staffId, actor }));
      }

      case 'textsConnect': {
        // Creates sent.dm's webhook once. Owners only: it changes the sent.dm account.
        if (!admin.owner) return json({ error: 'Not authorized' }, 403);
        const host = context.url.hostname === 'admin.sunnyandranney.com' ? 'https://sunnyandranney.com' : context.url.origin;
        const result = await connectWebhook(db, env, { endpointUrl: `${host}/api/webhook/sent-dm/`, actor });
        if (!result.ok) return json({ error: result.message }, 502);
        return fresh({ connected: true, created: result.created });
      }

      case 'person': {
        const staffId = typeof body.staffId === 'string' ? body.staffId : '';
        switch (body.op) {
          case 'add':
            await addToSchedule(db, staffId);
            break;
          case 'remove':
            await removeFromSchedule(db, staffId);
            break;
          case 'up':
          case 'down':
            await moveOnSchedule(db, staffId, body.op === 'up' ? -1 : 1);
            break;
          case 'create': {
            const name = text(body.name, 100);
            if (!name) return json({ error: 'Add a name.' }, 400);
            await createScheduledPerson(db, name);
            break;
          }
          default:
            return json({ error: 'Invalid request' }, 400);
        }
        return fresh();
      }

      case 'calendar': {
        const staffId = typeof body.staffId === 'string' ? body.staffId : '';
        await resetCalendarToken(db, staffId, body.enabled === true);
        return fresh();
      }

      default:
        return json({ error: 'Invalid request' }, 400);
    }
  } catch (err) {
    if (err instanceof StaleError) return fresh({ error: err.message }, 409);
    throw err;
  }
};
