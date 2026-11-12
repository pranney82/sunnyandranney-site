import fallbackHours from '@/content/settings/hours.json';
import {
  cellKey,
  cellsFromSnapshot,
  emptyCell,
  groupTimeOff,
  quickPicks,
  shiftMinutes,
  snapshotCells,
  weekDates,
} from '@/lib/schedule/core.mjs';
import { readTexting, textsState, type TextsState } from '@/lib/schedule/texting';
import { addDays, localDate, utcToLocalInput, workweekStart } from '@/lib/time-clock/hours.mjs';

// ─── Types shared with the page ─────────────────────────────

export interface Shift {
  start: number | null;
  end: number | null;
  label: string;
  away: boolean;
}

export interface TimeOff {
  kind: 'off' | 'pto' | 'vacation' | 'sick';
  note: string;
}

export interface Cell {
  shift: Shift | null;
  off: TimeOff | null;
}

/** The revs a cell had when it was read. A write must name them. */
export interface Stamp {
  s: string;
  o: string;
}

export interface CellRow extends Cell {
  staffId: string;
  date: string;
  stamp: Stamp;
}

export interface Person {
  id: string;
  name: string;
  overtimeEligible: boolean;
  onSchedule: boolean;
  calendarToken: string | null;
  color: number;
}

export interface StoreHours {
  days: Array<{ day: string; open: string; close: string; closed: boolean }>;
  holidays: Array<{ date: string; label: string; closed: boolean; open: string; close: string }>;
}

export interface WeekState {
  weekStart: string;
  today: string;
  /** Store-local minutes after midnight when this was read. */
  nowMinutes: number;
  readOnly: boolean;
  people: Person[];
  /** Active staff who aren't on the schedule, for adding them. */
  others: Array<{ id: string; name: string }>;
  cells: CellRow[];
  days: Array<{ date: string; note: string; closed: boolean }>;
  weekNote: string;
  published: { at: string; by: string; snapshot: unknown[] } | null;
  storeHours: StoreHours;
  picks: Record<string, Array<{ start: number; end: number }>>;
  /** Time clock punches this week, in store-local minutes. */
  clock: Array<{ staffId: string; date: string; in: number; out: number | null }>;
  clockInUse: boolean;
  timeOff: Array<{ staffId: string; from: string; to: string; kind: TimeOff['kind']; note: string; days: number }>;
  /** Average scheduled minutes in recent weeks that had any shifts. */
  usualWeekMinutes: number | null;
  lastWeekShifts: number;
  /** How long this week took to build, from the change history. */
  effort: { activeSeconds: number; actions: number } | null;
  /** Schedule texts: who's signed up and who publishing would text. Managers only. */
  texts: TextsState | null;
}

export interface Change {
  staffId: string;
  date: string;
  value: Cell;
  expect: Stamp;
}

const nowIso = () => new Date().toISOString();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Reading ─────────────────────────────────────────────────

interface PersonRow {
  id: string;
  display_name: string;
  overtime_eligible: number;
  active: number;
  position: number | null;
  calendar_token: string | null;
}

async function readPeople(db: D1Database): Promise<PersonRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.display_name, s.overtime_eligible, s.active, p.position, p.calendar_token
       FROM staff s LEFT JOIN schedule_people p ON p.staff_id = s.id
       ORDER BY p.position IS NULL, p.position, s.display_name`,
    )
    .all<PersonRow>();
  return results;
}

export async function readStoreHours(db: D1Database): Promise<StoreHours> {
  try {
    const row = await db.prepare(`SELECT value FROM settings WHERE key = 'settings:hours'`).first<{ value: string }>();
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<StoreHours>;
      if (Array.isArray(parsed.days) && parsed.days.length === 7) {
        return { days: parsed.days, holidays: Array.isArray(parsed.holidays) ? parsed.holidays : [] };
      }
    }
  } catch (err) {
    console.error('Store hours read failed, using the committed fallback', err);
  }
  return { days: fallbackHours.days, holidays: fallbackHours.holidays as StoreHours['holidays'] };
}

interface ShiftRow {
  staff_id: string;
  date: string;
  start_min: number | null;
  end_min: number | null;
  label: string;
  away: number;
  rev: string;
}

interface OffRow {
  staff_id: string;
  date: string;
  kind: TimeOff['kind'];
  note: string;
  rev: string;
}

async function readCells(db: D1Database, from: string, to: string): Promise<CellRow[]> {
  const [shifts, offs] = await db.batch<ShiftRow | OffRow>([
    db
      .prepare(`SELECT staff_id, date, start_min, end_min, label, away, rev FROM schedule_shifts WHERE date >= ? AND date <= ?`)
      .bind(from, to),
    db.prepare(`SELECT staff_id, date, kind, note, rev FROM schedule_time_off WHERE date >= ? AND date <= ?`).bind(from, to),
  ]);
  const cells = new Map<string, CellRow>();
  const at = (staffId: string, date: string) => {
    const key = cellKey(staffId, date);
    let cell = cells.get(key);
    if (!cell) {
      cell = { staffId, date, shift: null, off: null, stamp: { s: '', o: '' } };
      cells.set(key, cell);
    }
    return cell;
  };
  for (const row of shifts.results as ShiftRow[]) {
    const cell = at(row.staff_id, row.date);
    cell.shift = { start: row.start_min, end: row.end_min, label: row.label, away: row.away === 1 };
    cell.stamp.s = row.rev;
  }
  for (const row of offs.results as OffRow[]) {
    const cell = at(row.staff_id, row.date);
    cell.off = { kind: row.kind, note: row.note };
    cell.stamp.o = row.rev;
  }
  return [...cells.values()];
}

/** Active time spent on a week: gaps between changes, each capped at five minutes. */
function effortFrom(times: string[]): WeekState['effort'] {
  if (times.length === 0) return null;
  const stamps = [...new Set(times)].map((t) => Date.parse(t)).sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < stamps.length; i++) active += Math.min(stamps[i] - stamps[i - 1], 5 * 60 * 1000);
  return { activeSeconds: Math.round(active / 1000), actions: stamps.length };
}

export async function loadWeek(
  db: D1Database,
  weekStart: string,
  options: { readOnly: boolean; textsReady?: boolean },
): Promise<WeekState> {
  const dates = weekDates(weekStart);
  const weekEnd = dates[6];
  const nowLocal = utcToLocalInput(nowIso());
  const today = nowLocal.slice(0, 10);
  const nowMinutes = Number(nowLocal.slice(11, 13)) * 60 + Number(nowLocal.slice(14, 16));
  const historyFrom = addDays(weekStart, -56);

  const [peopleRows, cellRows, storeHours, texting, batch] = await Promise.all([
    readPeople(db),
    readCells(db, weekStart, weekEnd),
    readStoreHours(db),
    // Texts never stop the schedule loading, even before their tables exist.
    options.readOnly
      ? null
      : readTexting(db, weekStart).catch((err) => {
          console.error('Schedule texts read failed', err);
          return null;
        }),
    db.batch<Record<string, unknown>>([
      db.prepare(`SELECT date, note, closed FROM schedule_days WHERE date >= ? AND date <= ?`).bind(weekStart, weekEnd),
      db.prepare(`SELECT note, published_json, published_at, published_by FROM schedule_weeks WHERE week_start = ?`).bind(weekStart),
      db
        .prepare(`SELECT staff_id, date, start_min, end_min, label FROM schedule_shifts WHERE date >= ? AND date < ?`)
        .bind(historyFrom, weekStart),
      db
        .prepare(
          `SELECT t.staff_id, t.clock_in_at, t.clock_out_at FROM time_entries t
           WHERE t.status <> 'rejected' AND t.clock_in_at >= ? AND t.clock_in_at < ?`,
        )
        // A day either side, so every store-local date in the week is covered.
        .bind(`${addDays(weekStart, -1)}T00:00:00.000Z`, `${addDays(weekEnd, 2)}T00:00:00.000Z`),
      db.prepare(`SELECT 1 FROM time_entries LIMIT 1`),
      db
        .prepare(`SELECT staff_id, date, kind, note FROM schedule_time_off WHERE date >= ? AND date <= ? ORDER BY date`)
        .bind(addDays(today, -14), addDays(today, 365)),
      db
        .prepare(
          `SELECT created_at FROM schedule_events
           WHERE date >= ? AND date <= ? AND created_at > COALESCE((SELECT published_at FROM schedule_weeks WHERE week_start = ?), '')
           ORDER BY created_at`,
        )
        .bind(weekStart, weekEnd, weekStart),
    ]),
  ]);

  const [daysRes, weekRes, historyRes, clockRes, clockAnyRes, timeOffRes, effortRes] = batch;
  const week = weekRes.results[0] as
    | { note: string; published_json: string | null; published_at: string | null; published_by: string | null }
    | undefined;

  const published =
    week?.published_json && week.published_at
      ? { at: week.published_at, by: week.published_by ?? '', snapshot: JSON.parse(week.published_json) as unknown[] }
      : null;

  // The store tablet shows staff only what was published.
  let cells = cellRows;
  if (options.readOnly) {
    cells = [...(cellsFromSnapshot(published?.snapshot ?? []) as Map<string, Cell>).entries()].map(([key, cell]) => {
      const [staffId, date] = key.split('|');
      return { staffId, date, ...cell, stamp: { s: '', o: '' } };
    });
  }

  const withCells = new Set(cells.map((c) => c.staffId));
  const people: Person[] = [];
  const others: WeekState['others'] = [];
  peopleRows.forEach((row) => {
    const onSchedule = row.position !== null;
    if (onSchedule || withCells.has(row.id)) {
      people.push({
        id: row.id,
        name: row.display_name,
        overtimeEligible: row.overtime_eligible === 1,
        onSchedule,
        calendarToken: options.readOnly ? null : row.calendar_token,
        color: 0,
      });
    } else if (row.active) {
      others.push({ id: row.id, name: row.display_name });
    }
  });

  // Six colors in schedule order, so no two of the first six people match.
  people.forEach((person, index) => (person.color = index % 6));

  const history = historyRes.results as Array<{
    staff_id: string;
    date: string;
    start_min: number | null;
    end_min: number | null;
    label: string;
  }>;
  const picks: WeekState['picks'] = {};
  for (const person of people) {
    picks[person.id] = quickPicks(history, person.id, 3).map(({ start, end }) => ({ start, end }));
  }

  const weekMinutes = new Map<string, number>();
  for (const row of history) {
    const ws = workweekStart(row.date);
    weekMinutes.set(ws, (weekMinutes.get(ws) ?? 0) + shiftMinutes({ start: row.start_min, end: row.end_min }));
  }
  const counted = [...weekMinutes.values()].filter((m) => m > 0);
  const usualWeekMinutes = counted.length ? Math.round(counted.reduce((a, b) => a + b, 0) / counted.length) : null;
  const lastWeekStart = addDays(weekStart, -7);
  const lastWeekShifts = history.filter((row) => row.date >= lastWeekStart).length;

  const clock: WeekState['clock'] = [];
  for (const row of clockRes.results as Array<{ staff_id: string; clock_in_at: string; clock_out_at: string | null }>) {
    const inLocal = utcToLocalInput(row.clock_in_at);
    const date = inLocal.slice(0, 10);
    if (date < weekStart || date > weekEnd) continue;
    const minutes = (local: string) => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
    let out: number | null = null;
    if (row.clock_out_at) {
      const outLocal = utcToLocalInput(row.clock_out_at);
      out = outLocal.slice(0, 10) === date ? minutes(outLocal) : 1440;
    }
    clock.push({ staffId: row.staff_id, date, in: minutes(inLocal), out });
  }

  return {
    weekStart,
    today,
    nowMinutes,
    readOnly: options.readOnly,
    people,
    others: options.readOnly ? [] : others,
    cells,
    days: (daysRes.results as Array<{ date: string; note: string; closed: number }>).map((d) => ({
      date: d.date,
      note: d.note,
      closed: d.closed === 1,
    })),
    weekNote: week?.note ?? '',
    published,
    storeHours,
    picks,
    clock: options.readOnly ? [] : clock,
    clockInUse: !options.readOnly && clockAnyRes.results.length > 0,
    timeOff: options.readOnly
      ? []
      : (groupTimeOff(timeOffRes.results as Array<{ staff_id: string; date: string; kind: string; note: string }>) as WeekState['timeOff']),
    usualWeekMinutes,
    lastWeekShifts,
    effort: options.readOnly ? null : effortFrom((effortRes.results as Array<{ created_at: string }>).map((r) => r.created_at)),
    texts: texting
      ? textsState(texting, {
          weekStart,
          today,
          peopleIds: people.map((p) => p.id),
          cells: new Map(cellRows.map((r) => [cellKey(r.staffId, r.date), r])),
          ready: options.textsReady ?? false,
        })
      : null,
  };
}

// ─── Writing cells ───────────────────────────────────────────

export class StaleError extends Error {
  constructor() {
    super('Someone else changed this part of the schedule. It now shows their change.');
  }
}

/**
 * Applies cell changes as one transaction. Six statements whatever the number
 * of cells, so a whole week copies in one go. If any cell's revs differ from
 * what the manager read, the guard fails and nothing is written.
 */
export async function applyChanges(db: D1Database, changes: Change[], actor: string, action: string): Promise<void> {
  if (changes.length === 0) return;
  const now = nowIso();
  const payload = JSON.stringify(
    changes.map((c) => ({
      staffId: c.staffId,
      date: c.date,
      s: c.expect.s,
      o: c.expect.o,
      shift: c.value.shift ? { ...c.value.shift, away: c.value.shift.away ? 1 : 0 } : null,
      off: c.value.off,
    })),
  );

  const J = (path: string) => `json_extract(j.value, '${path}')`;
  const thisCell = `x.staff_id = ${J('$.staffId')} AND x.date = ${J('$.date')}`;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO schedule_guard (ok)
           SELECT 0 FROM json_each(?1) j
           WHERE COALESCE((SELECT x.rev FROM schedule_shifts x WHERE ${thisCell}), '') <> ${J('$.s')}
              OR COALESCE((SELECT x.rev FROM schedule_time_off x WHERE ${thisCell}), '') <> ${J('$.o')}
           LIMIT 1`,
        )
        .bind(payload),
      db
        .prepare(
          `INSERT INTO schedule_events (actor, action, staff_id, date, before_json, after_json, created_at)
           SELECT ?2, ?3, ${J('$.staffId')}, ${J('$.date')},
             json_object(
               'shift', json((SELECT json_object('start', x.start_min, 'end', x.end_min, 'label', x.label, 'away', x.away)
                              FROM schedule_shifts x WHERE ${thisCell})),
               'off', json((SELECT json_object('kind', x.kind, 'note', x.note)
                            FROM schedule_time_off x WHERE ${thisCell}))),
             json_object('shift', json(${J('$.shift')}), 'off', json(${J('$.off')})),
             ?4
           FROM json_each(?1) j`,
        )
        .bind(payload, actor, action, now),
      db
        .prepare(
          `INSERT INTO schedule_shifts (staff_id, date, start_min, end_min, label, away, rev, updated_by, updated_at)
           SELECT ${J('$.staffId')}, ${J('$.date')}, ${J('$.shift.start')}, ${J('$.shift.end')}, ${J('$.shift.label')},
             ${J('$.shift.away')}, lower(hex(randomblob(8))), ?2, ?3
           FROM json_each(?1) j WHERE ${J('$.shift')} IS NOT NULL
           ON CONFLICT (staff_id, date) DO UPDATE SET
             start_min = excluded.start_min, end_min = excluded.end_min, label = excluded.label, away = excluded.away,
             rev = excluded.rev, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(payload, actor, now),
      db
        .prepare(
          `DELETE FROM schedule_shifts WHERE (staff_id, date) IN (
             SELECT ${J('$.staffId')}, ${J('$.date')} FROM json_each(?1) j WHERE ${J('$.shift')} IS NULL)`,
        )
        .bind(payload),
      db
        .prepare(
          `INSERT INTO schedule_time_off (staff_id, date, kind, note, rev, updated_by, updated_at)
           SELECT ${J('$.staffId')}, ${J('$.date')}, ${J('$.off.kind')}, ${J('$.off.note')}, lower(hex(randomblob(8))), ?2, ?3
           FROM json_each(?1) j WHERE ${J('$.off')} IS NOT NULL
           ON CONFLICT (staff_id, date) DO UPDATE SET
             kind = excluded.kind, note = excluded.note, rev = excluded.rev,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(payload, actor, now),
      db
        .prepare(
          `DELETE FROM schedule_time_off WHERE (staff_id, date) IN (
             SELECT ${J('$.staffId')}, ${J('$.date')} FROM json_each(?1) j WHERE ${J('$.off')} IS NULL)`,
        )
        .bind(payload),
    ]);
  } catch (err) {
    if (String(err).includes('CHECK constraint failed')) throw new StaleError();
    throw err;
  }
}

/**
 * The revs cells have now. The page keeps them for cells outside the week it
 * shows (a vacation that runs on), so undoing that change can name them.
 */
export async function stampsFor(db: D1Database, keys: Array<{ staffId: string; date: string }>): Promise<Record<string, Stamp>> {
  const out: Record<string, Stamp> = {};
  if (keys.length === 0) return out;
  for (const k of keys) out[cellKey(k.staffId, k.date)] = { s: '', o: '' };
  const payload = JSON.stringify(keys);
  const match = `(staff_id, date) IN (SELECT json_extract(value, '$.staffId'), json_extract(value, '$.date') FROM json_each(?))`;
  const [shifts, offs] = await db.batch<{ staff_id: string; date: string; rev: string }>([
    db.prepare(`SELECT staff_id, date, rev FROM schedule_shifts WHERE ${match}`).bind(payload),
    db.prepare(`SELECT staff_id, date, rev FROM schedule_time_off WHERE ${match}`).bind(payload),
  ]);
  for (const r of shifts.results) out[cellKey(r.staff_id, r.date)].s = r.rev;
  for (const r of offs.results) out[cellKey(r.staff_id, r.date)].o = r.rev;
  return out;
}

/** Every staff id that exists, so a change can't name someone made up. */
export async function knownStaff(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { results } = await db
    .prepare(`SELECT id FROM staff WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify([...new Set(ids)]))
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/**
 * Sets or clears time off across a range of days. Cells are read here and
 * written with the revs just read, so this can't overwrite a change made in
 * between. Returns the changes, so the page can offer to undo them.
 */
export async function setTimeOffRange(
  db: D1Database,
  input: { staffId: string; from: string; to: string; off: TimeOff | null; removeShifts: boolean },
  actor: string,
): Promise<Array<{ staffId: string; date: string; before: Cell; after: Cell }>> {
  const current = new Map((await readCells(db, input.from, input.to)).filter((c) => c.staffId === input.staffId).map((c) => [c.date, c]));
  const changes: Change[] = [];
  const undo: Array<{ staffId: string; date: string; before: Cell; after: Cell }> = [];
  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    const cell = current.get(date) ?? { ...emptyCell(), stamp: { s: '', o: '' } };
    const before: Cell = { shift: cell.shift, off: cell.off };
    if (!input.off && !cell.off) continue;
    const after: Cell = { shift: input.off && input.removeShifts ? null : cell.shift, off: input.off };
    changes.push({ staffId: input.staffId, date, value: after, expect: cell.stamp });
    undo.push({ staffId: input.staffId, date, before, after });
  }
  await applyChanges(db, changes, actor, input.off ? 'time-off' : 'time-off-clear');
  return undo;
}

// ─── Days, weeks, publishing ─────────────────────────────────

export async function setDay(db: D1Database, input: { date: string; note: string; closed: boolean }, actor: string) {
  const now = nowIso();
  const statements = [
    db
      .prepare(
        `INSERT INTO schedule_events (actor, action, date, before_json, after_json, created_at)
         VALUES (?, 'day', ?, (SELECT json_object('note', note, 'closed', closed) FROM schedule_days WHERE date = ?),
                 json_object('note', ?, 'closed', ?), ?)`,
      )
      .bind(actor, input.date, input.date, input.note, input.closed ? 1 : 0, now),
  ];
  if (!input.note && !input.closed) {
    statements.push(db.prepare(`DELETE FROM schedule_days WHERE date = ?`).bind(input.date));
  } else {
    statements.push(
      db
        .prepare(
          `INSERT INTO schedule_days (date, note, closed, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (date) DO UPDATE SET note = excluded.note, closed = excluded.closed,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(input.date, input.note, input.closed ? 1 : 0, actor, now),
    );
  }
  await db.batch(statements);
}

export async function setWeekNote(db: D1Database, weekStart: string, note: string, actor: string) {
  await db
    .prepare(
      `INSERT INTO schedule_weeks (week_start, note, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (week_start) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(weekStart, note, actor, nowIso())
    .run();
}

/**
 * Shows staff the week as it stands. The snapshot is built here from what's
 * saved, never from what a page sends.
 */
export async function publishWeek(db: D1Database, weekStart: string, actor: string): Promise<void> {
  const dates = weekDates(weekStart);
  const rows = await readCells(db, dates[0], dates[6]);
  const cells = new Map(rows.map((r) => [cellKey(r.staffId, r.date), { shift: r.shift, off: r.off }]));
  const snapshot = JSON.stringify(snapshotCells(cells, dates));
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO schedule_weeks (week_start, published_json, published_at, published_by, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4, ?3)
         ON CONFLICT (week_start) DO UPDATE SET published_json = excluded.published_json,
           published_at = excluded.published_at, published_by = excluded.published_by`,
      )
      .bind(weekStart, snapshot, now, actor),
    db
      .prepare(`INSERT INTO schedule_events (actor, action, date, after_json, created_at) VALUES (?, 'publish', ?, ?, ?)`)
      .bind(actor, weekStart, snapshot, now),
  ]);
}

// ─── People ──────────────────────────────────────────────────

export async function addToSchedule(db: D1Database, staffId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO schedule_people (staff_id, position, added_at)
       SELECT ?1, COALESCE((SELECT MAX(position) FROM schedule_people), 0) + 1, ?2
       WHERE EXISTS (SELECT 1 FROM staff WHERE id = ?1)
       ON CONFLICT (staff_id) DO NOTHING`,
    )
    .bind(staffId, nowIso())
    .run();
}

export async function removeFromSchedule(db: D1Database, staffId: string): Promise<void> {
  await db.prepare(`DELETE FROM schedule_people WHERE staff_id = ?`).bind(staffId).run();
}

/** Swaps someone with the person above or below them. */
export async function moveOnSchedule(db: D1Database, staffId: string, direction: -1 | 1): Promise<void> {
  const { results } = await db.prepare(`SELECT staff_id, position FROM schedule_people ORDER BY position`).all<{
    staff_id: string;
    position: number;
  }>();
  const index = results.findIndex((r) => r.staff_id === staffId);
  const other = results[index + direction];
  if (index < 0 || !other) return;
  const self = results[index];
  await db.batch([
    db.prepare(`UPDATE schedule_people SET position = ? WHERE staff_id = ?`).bind(other.position, self.staff_id),
    db.prepare(`UPDATE schedule_people SET position = ? WHERE staff_id = ?`).bind(self.position, other.staff_id),
  ]);
}

/** Someone new, straight onto the schedule. PIN and Gusto link are set on the Staff page. */
export async function createScheduledPerson(db: D1Database, name: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO staff (id, display_name, overtime_eligible, active, store_staff, created_at, updated_at)
         VALUES (?, ?, 1, 1, 1, ?, ?)`,
      )
      .bind(id, name, now, now),
    db
      .prepare(
        `INSERT INTO schedule_people (staff_id, position, added_at)
         VALUES (?, COALESCE((SELECT MAX(position) FROM schedule_people), 0) + 1, ?)`,
      )
      .bind(id, now),
  ]);
  return id;
}

// ─── Calendar feeds ──────────────────────────────────────────

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const CALENDAR_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A new secret link for someone's calendar. Any older link stops working. */
export async function resetCalendarToken(db: D1Database, staffId: string, enabled: boolean): Promise<void> {
  await db
    .prepare(`UPDATE schedule_people SET calendar_token = ?, calendar_token_created_at = ? WHERE staff_id = ?`)
    .bind(enabled ? newToken() : null, enabled ? nowIso() : null, staffId)
    .run();
}

export interface FeedData {
  staffId: string;
  name: string;
  weeks: Array<{ weekStart: string; publishedAt: string; snapshot: Array<Record<string, unknown>> }>;
  names: Map<string, string>;
  days: Map<string, { note: string; closed: boolean }>;
  storeHours: StoreHours;
}

/** Published weeks around today for the person this token belongs to, or null. */
export async function feedFor(db: D1Database, token: string): Promise<FeedData | null> {
  const person = await db
    .prepare(
      `SELECT s.id, s.display_name FROM schedule_people p JOIN staff s ON s.id = p.staff_id
       WHERE p.calendar_token = ? AND s.active = 1`,
    )
    .bind(token)
    .first<{ id: string; display_name: string }>();
  if (!person) return null;

  const today = localDate(nowIso());
  const from = workweekStart(addDays(today, -28));
  const to = addDays(today, 180);
  const [weeks, staff, days] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT week_start, published_at, published_json FROM schedule_weeks
         WHERE published_json IS NOT NULL AND week_start >= ? AND week_start <= ? ORDER BY week_start`,
      )
      .bind(from, to),
    db.prepare(`SELECT id, display_name FROM staff`),
    db.prepare(`SELECT date, note, closed FROM schedule_days WHERE date >= ? AND date <= ?`).bind(from, addDays(to, 7)),
  ]);

  return {
    staffId: person.id,
    name: person.display_name,
    weeks: (weeks.results as Array<{ week_start: string; published_at: string; published_json: string }>).map((w) => ({
      weekStart: w.week_start,
      publishedAt: w.published_at,
      snapshot: JSON.parse(w.published_json),
    })),
    names: new Map((staff.results as Array<{ id: string; display_name: string }>).map((s) => [s.id, s.display_name])),
    days: new Map(
      (days.results as Array<{ date: string; note: string; closed: number }>).map((d) => [d.date, { note: d.note, closed: d.closed === 1 }]),
    ),
    storeHours: await readStoreHours(db),
  };
}

export function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value);
}
