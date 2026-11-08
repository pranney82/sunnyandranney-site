/**
 * What the manager needs to know today, worked out from the time clock and the
 * schedule. Everything here reads the store's own database, so the Today page
 * renders without waiting on Gusto.
 */
import {
  WEEKLY_OVERTIME_THRESHOLD_MINUTES,
  addDays,
  classifyEntries,
  localDate,
  localInputToUtc,
  utcToLocalInput,
  workedMinutes,
  workweekStart,
} from '../time-clock/hours.mjs';

/** A shift this long is almost always a forgotten clock-out, so it is never approved in bulk. */
export const LONG_SHIFT_MINUTES = 12 * 60;

/** Minutes after a scheduled start before someone counts as late, and before a no-show. */
export const LATE_GRACE_MINUTES = 5;
export const NO_SHOW_MINUTES = 15;

/**
 * How someone's clock compares with today's shift. The same rules as the
 * scheduler's clock view, kept here so Today works without the schedule.
 * @returns {{kind:'working'|'late'|'no-show'|'done'|'scheduled'|'unscheduled', minutes?:number, in?:number, out?:number|null}}
 */
export function floorStatus(shift, punches, nowMinutes) {
  const sorted = [...punches].sort((a, b) => a.in - b.in);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const start = shift && !shift.away ? shift.start : null;
  if (!first) {
    if (start === null || start === undefined) return { kind: 'scheduled' };
    return nowMinutes > start + NO_SHOW_MINUTES ? { kind: 'no-show', minutes: nowMinutes - start } : { kind: 'scheduled' };
  }
  const late = start !== null && start !== undefined && first.in - start > LATE_GRACE_MINUTES ? first.in - start : 0;
  if (!shift) return { kind: last.out === null ? 'working' : 'done', in: first.in, out: last.out, unscheduled: true };
  if (last.out === null) return { kind: late ? 'late' : 'working', minutes: late, in: first.in, out: null };
  return { kind: 'done', minutes: late, in: first.in, out: last.out };
}

/** Store-local minutes after midnight for an instant. */
export function localMinutes(iso) {
  const [, time] = utcToLocalInput(iso).split('T');
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Longest shift the hours API accepts. */
const MAX_SHIFT_MINUTES = 16 * 60;
/** How many past clock-outs it takes before "usual" means anything. */
const USUAL_MIN_SAMPLES = 3;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * A clock-out to offer for a shift someone forgot to close: the scheduled end
 * that day, or else the time they usually clock out on that weekday (any day,
 * if there aren't enough of those). Never a time that hasn't happened yet, and
 * never a shift the hours API would refuse.
 * @param {{clockInAt:string, scheduledEnd:number|null, usualEnds:Array<{weekday:number, minutes:number}>, now:string}} input
 * @returns {{at:string, local:string, source:'schedule'|'usual'}|null}
 */
export function suggestClockOut({ clockInAt, scheduledEnd, usualEnds, now }) {
  const day = localDate(clockInAt);
  const inMinutes = localMinutes(clockInAt);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const sameDay = usualEnds.filter((end) => end.weekday === weekday);
  const usual = (sameDay.length >= USUAL_MIN_SAMPLES ? sameDay : usualEnds).map((end) => end.minutes);
  const candidates = [];
  if (scheduledEnd !== null && scheduledEnd !== undefined) candidates.push({ minutes: scheduledEnd, source: 'schedule' });
  if (usual.length >= USUAL_MIN_SAMPLES) candidates.push({ minutes: median(usual), source: 'usual' });
  for (const { minutes, source } of candidates) {
    if (minutes <= inMinutes || minutes >= 24 * 60) continue;
    const local = `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const at = localInputToUtc(local);
    if (!at || at > now || workedMinutes(clockInAt, at) > MAX_SHIFT_MINUTES) continue;
    return { at, local, source };
  }
  return null;
}

/**
 * @param {object} input
 * @param {Array<object>} input.entries time_entries joined with staff (display_name, email, overtime_eligible)
 * @param {Array<{id:string, display_name:string}>} input.people store people on the clock or the schedule
 * @param {Array<{staff_id:string, date:string, start_min:number|null, end_min:number|null, away:number}>} input.schedule this week's shifts
 * @param {string} input.now ISO instant
 * @param {string} input.myEmail the signed-in manager, who can't approve their own hours
 * @param {Map<string, Array<{weekday:number, minutes:number}>>} [input.usualEnds] each person's recent clock-outs
 */
export function buildToday({ entries, people, schedule, now, myEmail, usualEnds = new Map() }) {
  const today = localDate(now);
  const weekStart = workweekStart(today);
  const weekEnd = addDays(weekStart, 6);
  const nowMinutes = localMinutes(now);
  const me = (myEmail ?? '').toLowerCase();
  const nameOf = new Map(people.map((person) => [person.id, person.display_name]));
  for (const entry of entries) if (!nameOf.has(entry.staff_id)) nameOf.set(entry.staff_id, entry.display_name);

  const live = entries.filter((entry) => entry.status !== 'rejected');

  // Open shifts: still working, or a clock-out someone forgot.
  const missedClockOuts = [];
  const onClock = [];
  const shiftOn = new Map(schedule.map((s) => [`${s.staff_id}|${s.date}`, s]));
  for (const entry of live.filter((e) => !e.clock_out_at)) {
    const minutes = workedMinutes(entry.clock_in_at, now);
    const item = { id: entry.id, version: entry.version, staffId: entry.staff_id, name: entry.display_name, clockInAt: entry.clock_in_at, minutes };
    if (localDate(entry.clock_in_at) < today || minutes > LONG_SHIFT_MINUTES) {
      const shift = shiftOn.get(`${entry.staff_id}|${localDate(entry.clock_in_at)}`);
      const isSelf = Boolean(me) && (entry.email ?? '').toLowerCase() === me;
      missedClockOuts.push({
        ...item,
        isSelf,
        suggestion: isSelf
          ? null
          : suggestClockOut({
              clockInAt: entry.clock_in_at,
              scheduledEnd: shift && !shift.away ? shift.end_min : null,
              usualEnds: usualEnds.get(entry.staff_id) ?? [],
              now,
            }),
      });
    } else onClock.push(item);
  }

  // Finished shifts waiting for review. Clean ones can be approved together; the rest need a look.
  const pending = live.filter((e) => e.status === 'pending' && e.clock_out_at && !e.push_state);
  const ready = [];
  const needsLook = [];
  for (const entry of pending) {
    const minutes = workedMinutes(entry.clock_in_at, entry.clock_out_at);
    const isSelf = Boolean(me) && (entry.email ?? '').toLowerCase() === me;
    const item = { id: entry.id, version: entry.version, staffId: entry.staff_id, name: entry.display_name, clockInAt: entry.clock_in_at, clockOutAt: entry.clock_out_at, minutes, isSelf };
    if (isSelf) continue;
    if (minutes > LONG_SHIFT_MINUTES) needsLook.push({ ...item, reason: 'long' });
    else ready.push(item);
  }

  // This week: hours so far, what's still scheduled, and who will pass 40.
  const weekEntries = live.filter((e) => {
    const day = localDate(e.clock_in_at);
    return day >= weekStart && day <= weekEnd;
  });
  const closedWeek = weekEntries.filter((e) => e.clock_out_at);
  const split = classifyEntries(closedWeek);
  const worked = new Map();
  for (const entry of closedWeek) {
    const { regularMinutes, overtimeMinutes } = split.get(entry.id);
    worked.set(entry.staff_id, (worked.get(entry.staff_id) ?? 0) + regularMinutes + overtimeMinutes);
  }
  for (const item of onClock) worked.set(item.staffId, (worked.get(item.staffId) ?? 0) + item.minutes);

  const clockedToday = new Set(live.filter((e) => localDate(e.clock_in_at) === today).map((e) => e.staff_id));
  const remaining = new Map();
  for (const shift of schedule) {
    if (shift.away || shift.start_min === null || shift.end_min === null) continue;
    if (shift.date < today || shift.date > weekEnd) continue;
    if (shift.date === today && clockedToday.has(shift.staff_id)) continue;
    let minutes = shift.end_min - shift.start_min;
    if (shift.date === today) minutes = Math.max(0, shift.end_min - Math.max(shift.start_min, nowMinutes));
    remaining.set(shift.staff_id, (remaining.get(shift.staff_id) ?? 0) + minutes);
  }
  const eligible = new Map(entries.map((e) => [e.staff_id, Boolean(e.overtime_eligible)]));
  const weekIds = new Set([...worked.keys(), ...remaining.keys()]);
  const week = [...weekIds]
    .map((staffId) => {
      const workedMin = worked.get(staffId) ?? 0;
      const remainingMin = remaining.get(staffId) ?? 0;
      const projected = workedMin + remainingMin;
      return {
        staffId,
        name: nameOf.get(staffId) ?? 'Unknown',
        workedMinutes: workedMin,
        scheduledMinutes: remainingMin,
        projectedMinutes: projected,
        overtimeRisk: eligible.get(staffId) !== false && projected > WEEKLY_OVERTIME_THRESHOLD_MINUTES,
      };
    })
    .sort((a, b) => b.projectedMinutes - a.projectedMinutes || a.name.localeCompare(b.name));

  // On the floor today: the schedule against the clock.
  const todayShifts = new Map(schedule.filter((s) => s.date === today).map((s) => [s.staff_id, s]));
  const punchesToday = new Map();
  for (const entry of live.filter((e) => localDate(e.clock_in_at) === today)) {
    const list = punchesToday.get(entry.staff_id) ?? [];
    list.push({ in: localMinutes(entry.clock_in_at), out: entry.clock_out_at ? localMinutes(entry.clock_out_at) : null });
    punchesToday.set(entry.staff_id, list);
  }
  const floorIds = new Set([...todayShifts.keys(), ...punchesToday.keys()]);
  const floor = [...floorIds]
    .map((staffId) => {
      const shift = todayShifts.get(staffId) ?? null;
      const status = floorStatus(
        shift ? { start: shift.start_min, end: shift.end_min, away: Boolean(shift.away) } : null,
        punchesToday.get(staffId) ?? [],
        nowMinutes,
      );
      return { staffId, name: nameOf.get(staffId) ?? 'Unknown', shift, status };
    })
    .sort((a, b) => (a.shift?.start_min ?? 9999) - (b.shift?.start_min ?? 9999) || a.name.localeCompare(b.name));

  return {
    today,
    weekStart,
    missedClockOuts,
    onClock,
    ready,
    needsLook,
    week,
    floor,
    lateOrMissing: floor.filter((p) => p.status.kind === 'no-show' || p.status.kind === 'late'),
  };
}

/** Reads what buildToday needs. The schedule is optional: without its tables, Today still works. */
export async function loadToday(db, { now, myEmail }) {
  const today = localDate(now);
  const weekStart = workweekStart(today);
  const since = localInputToUtc(`${addDays(weekStart, -60)}T00:00`);
  const weekFrom = localInputToUtc(`${weekStart}T00:00`);
  const [{ results: entries }, { results: people }] = await Promise.all([
    db
      .prepare(
        `SELECT e.*, s.display_name, s.email, s.overtime_eligible
         FROM time_entries e JOIN staff s ON s.id = e.staff_id
         WHERE e.status <> 'rejected'
           AND (e.clock_in_at >= ? OR (e.clock_in_at >= ? AND (e.clock_out_at IS NULL OR (e.status = 'pending' AND e.push_state IS NULL))))
         ORDER BY e.clock_in_at`,
      )
      .bind(weekFrom, since)
      .all(),
    db.prepare('SELECT id, display_name FROM staff WHERE active = 1 OR (store_staff = 1 AND gusto_terminated = 0)').all(),
  ]);
  // Recent finished shifts, for each person's usual clock-out time.
  const { results: recent } = await db
    .prepare(
      `SELECT staff_id, clock_in_at, clock_out_at FROM time_entries
       WHERE clock_out_at IS NOT NULL AND status <> 'rejected' AND clock_in_at >= ?
       ORDER BY clock_in_at DESC LIMIT 600`,
    )
    .bind(since)
    .all();
  const usualEnds = new Map();
  for (const shift of recent) {
    const day = localDate(shift.clock_in_at);
    if (localDate(shift.clock_out_at) !== day) continue;
    const list = usualEnds.get(shift.staff_id) ?? [];
    list.push({ weekday: new Date(`${day}T00:00:00Z`).getUTCDay(), minutes: localMinutes(shift.clock_out_at) });
    usualEnds.set(shift.staff_id, list);
  }

  let schedule = [];
  let hasSchedule = false;
  try {
    // From as far back as a forgotten clock-out can be, so its scheduled end can be offered.
    ({ results: schedule } = await db
      .prepare('SELECT staff_id, date, start_min, end_min, away FROM schedule_shifts WHERE date >= ? AND date <= ?')
      .bind(addDays(weekStart, -60), addDays(weekStart, 6))
      .all());
    hasSchedule = true;
  } catch {
    // The schedule isn't set up on this database yet.
  }
  return { ...buildToday({ entries, people, schedule, now, myEmail, usualEnds }), hasSchedule };
}
