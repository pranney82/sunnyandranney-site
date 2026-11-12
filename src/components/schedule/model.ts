/**
 * What the schedule screen works out from the week it was given, and how it
 * talks to the API. Rules live in lib/schedule/core.mjs so tests cover them.
 */
import {
  cellKey,
  changedSincePublish,
  coverage,
  hoursOn,
  holidayOn,
  weekAlerts,
  weekDates,
  weekTotals,
} from '@/lib/schedule/core.mjs';
import type { Cell, CellRow, Person, Stamp, WeekState } from '@/lib/schedule/store';

export type { Cell, CellRow, Person, Stamp, WeekState };

export interface Hours {
  open: number;
  close: number;
}

export interface Alert {
  id: string;
  severity: 'problem' | 'warn' | 'info';
  kind: string;
  text: string;
  date: string | null;
  staffId: string | null;
}

export interface Derived {
  dates: string[];
  cells: Map<string, CellRow>;
  hoursByDate: Map<string, Hours | null>;
  closures: Map<string, { closed: boolean; note: string }>;
  holidays: Map<string, { label: string; closed: boolean }>;
  totals: { byPerson: Map<string, { minutes: number; openEnded: number; unhoured: number; shifts: number }>; byDate: Map<string, number>; week: number };
  alerts: Alert[];
  alertKeys: Map<string, Alert['severity']>;
  changed: Set<string>;
  coverage: Map<string, ReturnType<typeof coverage>>;
  punches: Map<string, Array<{ in: number; out: number | null }>>;
}

const EMPTY_STAMP: Stamp = { s: '', o: '' };

/** Cells as they'll be once pending saves land, over what the server last said. */
export function derive(state: WeekState, overlay: Map<string, Cell>): Derived {
  const dates = weekDates(state.weekStart);
  const cells = new Map<string, CellRow>();
  for (const row of state.cells) cells.set(cellKey(row.staffId, row.date), row);
  for (const [key, value] of overlay) {
    const [staffId, date] = key.split('|');
    if (!dates.includes(date)) continue;
    const stamp = cells.get(key)?.stamp ?? EMPTY_STAMP;
    cells.set(key, { staffId, date, shift: value.shift, off: value.off, stamp });
  }

  const closures = new Map(state.days.map((d) => [d.date, { closed: d.closed, note: d.note }]));
  const hoursByDate = new Map<string, Hours | null>();
  const holidays = new Map<string, { label: string; closed: boolean }>();
  for (const date of dates) {
    hoursByDate.set(date, hoursOn(date, state.storeHours, closures.get(date) ?? null));
    const holiday = holidayOn(date, state.storeHours);
    if (holiday) holidays.set(date, { label: holiday.label, closed: holiday.closed });
  }

  const people = state.people.map((p) => ({ id: p.id, name: p.name, overtimeEligible: p.overtimeEligible }));
  const totals = weekTotals(people, dates, cells);
  const alerts = state.readOnly
    ? []
    : (weekAlerts({ people, dates, cells, hoursByDate, closures, today: state.today }) as Alert[]);
  const alertKeys = new Map<string, Alert['severity']>();
  for (const alert of alerts) {
    if (!alert.staffId || !alert.date || alert.severity === 'info') continue;
    const key = cellKey(alert.staffId, alert.date);
    if (alertKeys.get(key) !== 'problem') alertKeys.set(key, alert.severity);
  }

  const coverageByDate = new Map<string, ReturnType<typeof coverage>>();
  for (const date of dates) {
    const shifts = state.people.map((p) => cells.get(cellKey(p.id, date))?.shift).filter(Boolean) as Array<{
      start: number | null;
      end: number | null;
      away: boolean;
    }>;
    coverageByDate.set(date, coverage(shifts, hoursByDate.get(date) ?? null));
  }

  const punches = new Map<string, Array<{ in: number; out: number | null }>>();
  for (const p of state.clock) {
    const key = cellKey(p.staffId, p.date);
    const list = punches.get(key) ?? [];
    list.push({ in: p.in, out: p.out });
    punches.set(key, list);
  }

  const changed =
    state.published && !state.readOnly ? changedSincePublish(state.published.snapshot, cells, dates) : new Set<string>();

  return { dates, cells, hoursByDate, closures, holidays, totals, alerts, alertKeys, changed, coverage: coverageByDate, punches };
}

export function cellAt(derived: Derived, staffId: string, date: string): Cell {
  const row = derived.cells.get(cellKey(staffId, date));
  return row ? { shift: row.shift, off: row.off } : { shift: null, off: null };
}

// ─── API ─────────────────────────────────────────────────────

export interface ApiResult {
  ok: boolean;
  status: number;
  state?: WeekState;
  error?: string;
  undo?: Array<{ staffId: string; date: string; before: Cell; after: Cell }>;
  stamps?: Record<string, Stamp>;
  /** After publishing: who was texted, and who couldn't be. */
  texts?: { ready: boolean; texted: string[]; failed: string[] };
  /** After saving a number or trying again: whether a text went. */
  texted?: boolean;
}

export async function postSchedule(body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const res = await fetch('/api/admin/schedule/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as (Omit<ApiResult, 'ok' | 'status'> & { error?: string }) | null;
    return { ok: res.ok, status: res.status, ...(data ?? {}), error: res.ok ? undefined : data?.error ?? 'Something went wrong. Try again.' };
  } catch {
    return { ok: false, status: 0, error: 'Couldn’t reach the server. Check the connection and try again.' };
  }
}

export async function fetchWeek(week: string): Promise<WeekState | null> {
  try {
    const res = await fetch(`/api/admin/schedule/?week=${encodeURIComponent(week)}`, { headers: { Accept: 'application/json' } });
    return res.ok ? ((await res.json()) as WeekState) : null;
  } catch {
    return null;
  }
}

// ─── Small helpers ───────────────────────────────────────────

/** Minutes after store-local midnight right now. */
export function storeNowMinutes(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/** "Ava Ruiz" → "AR", "Ben" → "B". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (parts[0][0] + last).toUpperCase();
}

export const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** "BJ", "BJ and Nikki", "BJ, Nikki and Tom". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function formatPublished(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}
