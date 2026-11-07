/**
 * Payroll hour calculations. Plain JS so the admin (Astro) and the push script
 * (Node) run the same code, and `npm test` can run it without a build step.
 */

export const STORE_TIME_ZONE = 'America/New_York';

/** 0 = Sunday. Must match the workweek configured in Gusto. */
export const WORKWEEK_START_DAY = 0;

/** Federal FLSA rule: over 40 hours in a workweek. Georgia adds no daily rule. */
export const WEEKLY_OVERTIME_THRESHOLD_MINUTES = 40 * 60;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function zonedParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** Store-local calendar date of a UTC instant, as YYYY-MM-DD. */
export function localDate(iso, timeZone = STORE_TIME_ZONE) {
  const p = zonedParts(Date.parse(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * An instant as store-local time with its UTC offset, such as
 * 2026-11-02T09:00:00-05:00. Gusto's record_time refuses a time without one.
 */
export function withOffset(iso, timeZone = STORE_TIME_ZONE) {
  const ms = Date.parse(iso);
  const p = zonedParts(ms, timeZone);
  const offsetMinutes = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Value for an <input type="datetime-local">, in store-local time. */
export function utcToLocalInput(iso, timeZone = STORE_TIME_ZONE) {
  const p = zonedParts(Date.parse(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Convert store-local wall time to a UTC ISO string. Returns null for malformed
 * input and for times that do not exist (such as the skipped DST hour).
 */
export function localInputToUtc(value, timeZone = STORE_TIME_ZONE) {
  const match = LOCAL_INPUT_RE.exec(value ?? '');
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);

  // The zone offset depends on the instant, so refine once around DST changes.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = wanted - (asIfUtc - guess);
  }

  const iso = new Date(guess).toISOString();
  return utcToLocalInput(iso, timeZone) === value ? iso : null;
}

export function isIsoDate(value) {
  const match = DATE_RE.exec(value ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Add calendar days to a YYYY-MM-DD date. Pure date math, so DST cannot shift it. */
export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** First day of the workweek containing a YYYY-MM-DD date. */
export function workweekStart(date, startDay = WORKWEEK_START_DAY) {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(date, -((weekday - startDay + 7) % 7));
}

/** Paid minutes in a shift, to the nearest minute so rounding favors neither side. */
export function workedMinutes(clockInAt, clockOutAt) {
  return Math.round((Date.parse(clockOutAt) - Date.parse(clockInAt)) / 60000);
}

/** Gusto expects hours as a decimal with three places. */
export function minutesToHours(minutes) {
  return (minutes / 60).toFixed(3);
}

/**
 * Split each closed shift into regular and overtime minutes.
 *
 * Shifts are walked oldest first within each person's workweek, so overtime
 * lands on the shifts that crossed 40 hours. A shift belongs to the workweek it
 * started in. Earlier shifts never change classification when later ones are
 * added, which keeps hours already sent to Gusto correct.
 *
 * Open shifts are skipped. Callers pass rejected shifts out before calling.
 *
 * @param {Array<{id: string, staff_id: string, clock_in_at: string, clock_out_at: string | null, overtime_eligible: number | boolean}>} entries
 * @returns {Map<string, {regularMinutes: number, overtimeMinutes: number, weekStart: string}>}
 */
export function classifyEntries(entries, { timeZone = STORE_TIME_ZONE, startDay = WORKWEEK_START_DAY } = {}) {
  const closed = entries
    .filter((entry) => entry.clock_out_at)
    .slice()
    .sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at));

  const minutesThisWeek = new Map();
  const result = new Map();

  for (const entry of closed) {
    const weekStart = workweekStart(localDate(entry.clock_in_at, timeZone), startDay);
    const key = `${entry.staff_id}|${weekStart}`;
    const before = minutesThisWeek.get(key) ?? 0;
    const minutes = workedMinutes(entry.clock_in_at, entry.clock_out_at);
    minutesThisWeek.set(key, before + minutes);

    const overtimeMinutes = entry.overtime_eligible
      ? Math.max(0, Math.min(minutes, before + minutes - WEEKLY_OVERTIME_THRESHOLD_MINUTES))
      : 0;

    result.set(entry.id, { regularMinutes: minutes - overtimeMinutes, overtimeMinutes, weekStart });
  }

  return result;
}
