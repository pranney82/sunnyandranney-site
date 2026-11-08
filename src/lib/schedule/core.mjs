/**
 * Staff schedule rules. Plain JS so the admin page, its API, the staff calendar
 * feed and `npm test` all run the same code.
 *
 * Dates are store-local YYYY-MM-DD. Times are minutes after store-local
 * midnight (540 = 9:00 AM), so nothing shifts when the clocks change.
 */

import { addDays, localInputToUtc } from '../time-clock/hours.mjs';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const TIME_OFF_KINDS = ['off', 'pto', 'vacation', 'sick'];
export const TIME_OFF_LABELS = { off: 'Off', pto: 'PTO', vacation: 'Vacation', sick: 'Sick' };

export const MAX_SHIFT_MINUTES = 16 * 60;
export const MAX_LABEL = 40;
export const MAX_NOTE = 120;
export const OVERTIME_MINUTES = 40 * 60;
/** Clocking in up to this many minutes after the shift starts still counts as on time. */
export const LATE_GRACE_MINUTES = 5;

const pad = (n) => String(n).padStart(2, '0');

// ─── Dates ───────────────────────────────────────────────────

export function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** "Nov 15 – 21", "Nov 29 – Dec 5", "Dec 27, 2026 – Jan 2, 2027". */
export function weekRangeLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const [y1, m1, d1] = weekStart.split('-').map(Number);
  const [y2, m2, d2] = end.split('-').map(Number);
  if (y1 !== y2) return `${MONTH_SHORT[m1 - 1]} ${d1}, ${y1} – ${MONTH_SHORT[m2 - 1]} ${d2}, ${y2}`;
  if (m1 !== m2) return `${MONTH_SHORT[m1 - 1]} ${d1} – ${MONTH_SHORT[m2 - 1]} ${d2}`;
  return `${MONTH_SHORT[m1 - 1]} ${d1} – ${d2}`;
}

/** "Mon, Nov 16". */
export function dayLabel(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${DAY_SHORT[weekdayOf(date)]}, ${MONTH_SHORT[m - 1]} ${d}`;
}

export function dayOfMonth(date) {
  return Number(date.slice(8, 10));
}

// ─── Times ───────────────────────────────────────────────────

/** Short wall-clock time like the sheet: 540 → "9", 630 → "10:30", 1020 → "5". */
export function clock(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return m ? `${h}:${pad(m)}` : String(h);
}

/** 540 → "9:00 AM", 1440 → "12:00 AM". */
export function clockLong(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${pad(m)} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** 540 → "9a", 1020 → "5p", 630 → "10:30a". For tight spaces such as the coverage axis. */
export function clockTiny(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  return `${clock(minutes)}${h24 < 12 ? 'a' : 'p'}`;
}

/** 480 → "8", 450 → "7.5", 465 → "7.75". */
export function hoursLabel(minutes) {
  return String(Number((minutes / 60).toFixed(2)));
}

/** "HH:MM" from settings → minutes. */
export function hhmmToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
  return h * 60 + m;
}

// ─── Parsing what the manager types ─────────────────────────

const OFF_WORDS = [
  [/^(?:day\s*off|off|out|closed)\b/i, 'off'],
  [/^(?:pto|pt0)\b/i, 'pto'],
  [/^(?:vacation|vacay|vac)\b/i, 'vacation'],
  [/^sick\b/i, 'sick'],
];

// A time: "9", "9:30", "930", "9a", "9:30 pm", "17", or the words open/close.
const TIME = String.raw`(?:open|close|\d{1,2}(?::?\d{2})?(?:\s*[ap]\.?m?\.?(?![a-z]))?)`;
const END = String.raw`(?:\?|${TIME})`;
const RANGE_RE = new RegExp(String.raw`(${TIME})\s*(?:-|–|—|to\b|until\b|til\b)\s*(${END})`, 'i');
const LONE_TIME_RE = new RegExp(String.raw`^${TIME}$`, 'i');

/** Work away from the store. These don't count toward who's minding the floor. */
const AWAY_RE = /\b(mart|market|warehouse|wh|off[- ]?site|away|deliver(y|ies)|drop[- ]?off|pick[- ]?up|errands?)\b/i;

function readTime(token) {
  const t = token.trim().toLowerCase();
  if (t === 'open' || t === 'close' || t === '?') return { word: t };
  const match = /^(\d{1,2})(?::?(\d{2}))?\s*(?:([ap])\.?m?\.?)?$/.exec(t);
  if (!match) return null;
  const h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  if (h > 24 || m > 59) return null;
  return { h, m, mer: match[3] ?? null };
}

/**
 * A start time without am/pm, read the way a shop schedule is written:
 * 7 to 11 are mornings, 12 is noon, 1 to 6 are afternoons ("3-6").
 */
function resolveStart(t) {
  if (t.mer) return ((t.h % 12) + (t.mer === 'p' ? 12 : 0)) * 60 + t.m;
  if (t.h >= 13) return t.h * 60 + t.m;
  if (t.h === 12) return 12 * 60 + t.m;
  if (t.h >= 1 && t.h <= 6) return (t.h + 12) * 60 + t.m;
  return t.h * 60 + t.m;
}

/** An end time without am/pm is the first one after the start: "9-5" ends at 5 PM. */
function resolveEnd(t, start) {
  if (t.mer) {
    const value = ((t.h % 12) + (t.mer === 'p' ? 12 : 0)) * 60 + t.m;
    return value === 0 ? 1440 : value;
  }
  if (t.h >= 13) return t.h * 60 + t.m;
  const morning = (t.h % 12) * 60 + t.m;
  for (const candidate of [morning, morning + 720, morning + 1440]) {
    if (candidate > start && candidate <= 1440) return candidate;
  }
  return null;
}

function tidyLabel(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:/–—-]+|[\s,;:/–—-]+$/g, '')
    .slice(0, MAX_LABEL);
}

/**
 * Reads a cell the way the sheet was typed:
 *   "9-5", "10:30-6", "9a-1p", "9-?" (no end yet), "10-close", "open-3",
 *   "Mart 9-5", "Mart", "off", "pto", "vac Disney", "-".
 * `hours` is the store's {open, close} that day, for "open" and "close".
 *
 * @param {unknown} input
 * @param {{open: number, close: number} | null} [hours]
 * @returns {{type:'clear'} | {type:'shift', start:number|null, end:number|null, label:string, away:boolean}
 *   | {type:'off', kind:string, note:string} | {type:'error', message:string}}
 */
export function parseCell(input, hours = null) {
  const text = String(input ?? '').trim();
  if (text === '' || /^[-–—]$/.test(text)) return { type: 'clear' };

  const range = RANGE_RE.exec(text);
  if (!range) {
    for (const [re, kind] of OFF_WORDS) {
      const match = re.exec(text);
      if (match) return { type: 'off', kind, note: tidyLabel(text.slice(match[0].length)).slice(0, MAX_NOTE) };
    }
    if (LONE_TIME_RE.test(text)) {
      return { type: 'error', message: 'Add an end time, like 9-5. Use 9-? if it isn’t set yet.' };
    }
    const label = tidyLabel(text);
    return { type: 'shift', start: null, end: null, label, away: AWAY_RE.test(label) };
  }

  const first = readTime(range[1]);
  const second = readTime(range[2]);
  if (!first || !second) return { type: 'error', message: 'That time doesn’t look right. Try 9-5 or 10:30-6.' };

  let start;
  if (first.word === 'open') {
    if (!hours) return { type: 'error', message: 'The store is closed that day, so “open” has no time.' };
    start = hours.open;
  } else if (first.word === 'close') {
    return { type: 'error', message: 'A shift can’t start at close.' };
  } else {
    start = resolveStart(first);
  }
  if (start >= 1440) return { type: 'error', message: 'That start time doesn’t look right.' };

  let end;
  if (second.word === '?') end = null;
  else if (second.word === 'close') {
    if (!hours) return { type: 'error', message: 'The store is closed that day, so “close” has no time.' };
    end = hours.close;
  } else if (second.word === 'open') {
    return { type: 'error', message: 'A shift can’t end at open.' };
  } else {
    end = resolveEnd(second, start);
    if (end === null) return { type: 'error', message: 'The end time has to be after the start, on the same day.' };
  }

  if (end !== null && end <= start) return { type: 'error', message: 'The end time has to be after the start, on the same day.' };
  if (end !== null && end - start > MAX_SHIFT_MINUTES) return { type: 'error', message: 'A shift can’t be longer than 16 hours.' };

  const label = tidyLabel(text.slice(0, range.index) + ' ' + text.slice(range.index + range[0].length));
  return { type: 'shift', start, end, label, away: AWAY_RE.test(label) };
}

/** Whether a label means work away from the store, for a fresh entry's default. */
export function looksAway(label) {
  return AWAY_RE.test(label ?? '');
}

function shortTime(minutes, role, start) {
  const plain = clock(minutes);
  const t = readTime(plain);
  const reread = role === 'start' ? resolveStart(t) : resolveEnd(t, start);
  if (reread === minutes) return plain;
  return `${plain}${Math.floor(minutes / 60) % 24 < 12 ? 'a' : 'p'}`;
}

/** What to put in the editor for a cell, written so parseCell reads it back the same. */
export function cellToInput(cell) {
  if (!cell) return '';
  if (cell.shift) {
    const { start, end, label } = cell.shift;
    if (start === null || start === undefined) return label ?? '';
    const s = shortTime(start, 'start');
    const e = end === null || end === undefined ? '?' : shortTime(end, 'end', start);
    return `${s}-${e}${label ? ` ${label}` : ''}`;
  }
  if (cell.off) {
    const word = { off: 'off', pto: 'pto', vacation: 'vacation', sick: 'sick' }[cell.off.kind] ?? 'off';
    return cell.off.note ? `${word} ${cell.off.note}` : word;
  }
  return '';
}

/** "9–5", "10:30–6", "9–?", or the label alone. */
export function shiftShort(shift) {
  if (shift.start === null || shift.start === undefined) return shift.label || 'Work';
  return `${clock(shift.start)}–${shift.end === null || shift.end === undefined ? '?' : clock(shift.end)}`;
}

export function shiftMinutes(shift) {
  if (!shift || shift.start === null || shift.start === undefined || shift.end === null || shift.end === undefined) return 0;
  return shift.end - shift.start;
}

/** Plain-language reading of a parse, shown under the editor as the manager types. */
export function describeParse(parsed) {
  switch (parsed.type) {
    case 'clear':
      return 'Empty';
    case 'error':
      return parsed.message;
    case 'off':
      return `${TIME_OFF_LABELS[parsed.kind]}${parsed.note ? ` · ${parsed.note}` : ''}`;
    case 'shift': {
      const where = parsed.away ? ' · away from the store' : '';
      const label = parsed.label ? `${parsed.label} · ` : '';
      if (parsed.start === null) return `${label || ''}No hours, so it isn’t counted${where}`;
      if (parsed.end === null) return `${label}${clockLong(parsed.start)} until ? · no end time yet${where}`;
      const hrs = hoursLabel(parsed.end - parsed.start);
      return `${label}${clockLong(parsed.start)} – ${clockLong(parsed.end)} · ${hrs} ${hrs === '1' ? 'hour' : 'hours'}${where}`;
    }
    default:
      return '';
  }
}

/** A parse as the cell value the API stores. */
export function parsedToCell(parsed) {
  if (parsed.type === 'clear') return { shift: null, off: null };
  if (parsed.type === 'shift') {
    return { shift: { start: parsed.start, end: parsed.end, label: parsed.label, away: parsed.away }, off: null };
  }
  if (parsed.type === 'off') return { shift: null, off: { kind: parsed.kind, note: parsed.note } };
  return null;
}

// ─── Cell values ─────────────────────────────────────────────

export const cellKey = (staffId, date) => `${staffId}|${date}`;

export function emptyCell() {
  return { shift: null, off: null };
}

export function isEmptyCell(cell) {
  return !cell || (!cell.shift && !cell.off);
}

function sameShift(a, b) {
  if (!a || !b) return !a && !b;
  return (
    (a.start ?? null) === (b.start ?? null) &&
    (a.end ?? null) === (b.end ?? null) &&
    (a.label ?? '') === (b.label ?? '') &&
    Boolean(a.away) === Boolean(b.away)
  );
}

function sameOff(a, b) {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && (a.note ?? '') === (b.note ?? '');
}

export function sameCell(a, b) {
  return sameShift(a?.shift ?? null, b?.shift ?? null) && sameOff(a?.off ?? null, b?.off ?? null);
}

/**
 * Checks a cell value sent to the API. Returns the cleaned value, or a message.
 * @returns {{shift: object|null, off: object|null} | string}
 */
export function validateCell(value) {
  if (!value || typeof value !== 'object') return 'Invalid cell';
  const out = { shift: null, off: null };
  if (value.shift) {
    const { start, end, label, away } = value.shift;
    const isInt = (n) => Number.isInteger(n);
    if (start !== null && !(isInt(start) && start >= 0 && start < 1440)) return 'Invalid start time';
    if (end !== null && !(isInt(end) && end > 0 && end <= 1440)) return 'Invalid end time';
    if (start === null && end !== null) return 'A shift with an end time needs a start time';
    if (start !== null && end !== null && end <= start) return 'The end time has to be after the start.';
    if (start !== null && end !== null && end - start > MAX_SHIFT_MINUTES) return 'A shift can’t be longer than 16 hours.';
    if (typeof label !== 'string' || label.length > MAX_LABEL) return 'Invalid label';
    if (start === null && label.trim() === '') return 'A shift needs hours or a label';
    out.shift = { start, end, label: label.trim(), away: away === true };
  }
  if (value.off) {
    const { kind, note } = value.off;
    if (!TIME_OFF_KINDS.includes(kind)) return 'Invalid kind of time off';
    if (typeof note !== 'string' || note.length > MAX_NOTE) return 'Invalid note';
    out.off = { kind, note: note.trim() };
  }
  return out;
}

// ─── Store hours ─────────────────────────────────────────────

/**
 * The store's hours on a date, or null when it's closed. A closure set on the
 * schedule wins, then Google's special hours (holidays), then the usual week.
 * @param {string} date
 * @param {{days: Array<{day:string, open:string, close:string, closed:boolean}>, holidays?: Array<{date:string, closed:boolean, open:string, close:string}>} | null} storeHours
 * @param {{closed?: number|boolean} | null} day
 */
export function hoursOn(date, storeHours, day = null) {
  if (day?.closed) return null;
  const holiday = storeHours?.holidays?.find((h) => h.date === date);
  if (holiday) {
    if (holiday.closed) return null;
    const open = hhmmToMinutes(holiday.open);
    const close = hhmmToMinutes(holiday.close);
    if (open !== null && close !== null && close > open) return { open, close };
  }
  const usual = storeHours?.days?.find((d) => d.day === DAY_NAMES[weekdayOf(date)]);
  if (!usual || usual.closed) return null;
  const open = hhmmToMinutes(usual.open);
  const close = hhmmToMinutes(usual.close);
  return open !== null && close !== null && close > open ? { open, close } : null;
}

/** Google's label for a special-hours date, if it has one ("Thanksgiving"). */
export function holidayOn(date, storeHours) {
  return storeHours?.holidays?.find((h) => h.date === date) ?? null;
}

// ─── Coverage ────────────────────────────────────────────────

/**
 * Who is minding the store through a day. Shifts away from the store and
 * shifts with no hours don't count. A shift with no end yet counts to close.
 *
 * @param {Array<{start:number|null, end:number|null, away?:boolean}>} shifts
 * @param {{open:number, close:number} | null} hours
 * @returns {{segments: Array<{from:number,to:number,count:number}>, gaps: Array<{from:number,to:number}>, peak:number, from:number|null, to:number|null}}
 */
export function coverage(shifts, hours) {
  const spans = shifts
    .filter((s) => !s.away && s.start !== null && s.start !== undefined)
    .map((s) => ({ from: s.start, to: s.end ?? Math.max(hours?.close ?? 0, s.start + 60) }));

  const points = new Set();
  if (hours) {
    points.add(hours.open);
    points.add(hours.close);
  }
  for (const span of spans) {
    points.add(span.from);
    points.add(span.to);
  }
  const sorted = [...points].sort((a, b) => a - b);
  if (sorted.length < 2) return { segments: [], gaps: [], peak: 0, from: null, to: null };

  const segments = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    const count = spans.filter((s) => s.from <= from && s.to >= to).length;
    const last = segments[segments.length - 1];
    if (last && last.count === count && last.to === from) last.to = to;
    else segments.push({ from, to, count });
  }

  const gaps = [];
  if (hours) {
    for (const seg of segments) {
      if (seg.count > 0) continue;
      const from = Math.max(seg.from, hours.open);
      const to = Math.min(seg.to, hours.close);
      if (to > from) gaps.push({ from, to });
    }
  }

  return {
    segments,
    gaps,
    peak: segments.reduce((max, s) => Math.max(max, s.count), 0),
    from: sorted[0],
    to: sorted[sorted.length - 1],
  };
}

// ─── Totals ──────────────────────────────────────────────────

/**
 * @param {Array<{id:string}>} people
 * @param {string[]} dates
 * @param {Map<string, {shift:object|null, off:object|null}>} cells
 */
export function weekTotals(people, dates, cells) {
  const byPerson = new Map();
  const byDate = new Map(dates.map((d) => [d, 0]));
  let week = 0;
  for (const person of people) {
    let minutes = 0;
    let openEnded = 0;
    let unhoured = 0;
    let shifts = 0;
    for (const date of dates) {
      const shift = cells.get(cellKey(person.id, date))?.shift;
      if (!shift) continue;
      shifts += 1;
      const m = shiftMinutes(shift);
      minutes += m;
      byDate.set(date, byDate.get(date) + m);
      if (shift.start !== null && shift.end === null) openEnded += 1;
      if (shift.start === null) unhoured += 1;
    }
    week += minutes;
    byPerson.set(person.id, { minutes, openEnded, unhoured, shifts });
  }
  return { byPerson, byDate, week };
}

// ─── Things to check ─────────────────────────────────────────

function rangeText(from, to) {
  return `${clockLong(from).replace(':00', '')}–${clockLong(to).replace(':00', '')}`;
}

/**
 * Everything on a week that needs the manager's eye, most serious first within
 * each day. Days before `today` are skipped: nothing can be done about them.
 *
 * @returns {Array<{id:string, severity:'problem'|'warn'|'info', kind:string, text:string, date:string|null, staffId:string|null}>}
 */
export function weekAlerts({ people, dates, cells, hoursByDate, closures, today }) {
  const alerts = [];
  const rank = { problem: 0, warn: 1, info: 2 };
  const totals = weekTotals(people, dates, cells);

  for (const date of dates) {
    if (today && date < today) continue;
    const hours = hoursByDate.get(date) ?? null;
    const dayShifts = people.map((p) => cells.get(cellKey(p.id, date))?.shift).filter(Boolean);

    for (const gap of coverage(dayShifts, hours).gaps) {
      alerts.push({
        id: `gap|${date}|${gap.from}`,
        severity: 'problem',
        kind: 'gap',
        text: `${dayLabel(date)}: nobody in the store ${rangeText(gap.from, gap.to)}`,
        date,
        staffId: null,
      });
    }

    for (const person of people) {
      const cell = cells.get(cellKey(person.id, date));
      if (!cell) continue;
      if (cell.shift && cell.off) {
        alerts.push({
          id: `conflict|${person.id}|${date}`,
          severity: 'problem',
          kind: 'conflict',
          text: `${person.name} is scheduled ${dayLabel(date)} but is off (${cell.off.kind === 'off' ? 'day off' : TIME_OFF_LABELS[cell.off.kind]})`,
          date,
          staffId: person.id,
        });
      }
      const closure = closures.get(date);
      if (cell.shift && !cell.shift.away && closure?.closed) {
        alerts.push({
          id: `closed|${person.id}|${date}`,
          severity: 'warn',
          kind: 'closed',
          text: `${person.name} is scheduled ${dayLabel(date)}, when the store is closed${closure.note ? ` (${closure.note})` : ''}`,
          date,
          staffId: person.id,
        });
      }
      if (cell.shift && cell.shift.start !== null && cell.shift.end === null) {
        alerts.push({
          id: `open|${person.id}|${date}`,
          severity: 'info',
          kind: 'open-end',
          text: `${person.name}’s shift ${dayLabel(date)} has no end time`,
          date,
          staffId: person.id,
        });
      }
      if (cell.shift && cell.shift.start === null) {
        alerts.push({
          id: `nohours|${person.id}|${date}`,
          severity: 'info',
          kind: 'no-hours',
          text: `${person.name}: “${cell.shift.label}” ${dayLabel(date)} has no hours, so it isn’t counted`,
          date,
          staffId: person.id,
        });
      }
    }
  }

  const lastDate = dates[dates.length - 1];
  if (!today || lastDate >= today) {
    for (const person of people) {
      if (!person.overtimeEligible) continue;
      const minutes = totals.byPerson.get(person.id)?.minutes ?? 0;
      if (minutes > OVERTIME_MINUTES) {
        alerts.push({
          id: `ot|${person.id}`,
          severity: 'warn',
          kind: 'overtime',
          text: `${person.name} is at ${hoursLabel(minutes)} hours, ${hoursLabel(minutes - OVERTIME_MINUTES)} of them overtime`,
          date: null,
          staffId: person.id,
        });
      }
    }
  }

  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.date ?? '').localeCompare(b.date ?? ''));
}

// ─── Quick picks ─────────────────────────────────────────────

/**
 * The shifts someone works most, so they're one tap away. Falls back to the
 * team's usual shifts for someone new.
 * @param {Array<{staff_id:string, start_min:number|null, end_min:number|null, label:string}>} history
 */
export function quickPicks(history, staffId, limit = 3) {
  const count = (rows) => {
    const tally = new Map();
    for (const row of rows) {
      if (row.start_min === null || row.end_min === null || row.label) continue;
      const key = `${row.start_min}|${row.end_min}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return [...tally.entries()]
      .map(([key, n]) => {
        const [start, end] = key.split('|').map(Number);
        return { start, end, count: n };
      })
      .sort((a, b) => b.count - a.count || a.start - b.start || a.end - b.end);
  };
  const own = count(history.filter((r) => r.staff_id === staffId));
  const picks = own.slice(0, limit);
  if (picks.length < limit) {
    for (const team of count(history)) {
      if (picks.length >= limit) break;
      if (!picks.some((p) => p.start === team.start && p.end === team.end)) picks.push(team);
    }
  }
  return picks;
}

// ─── Copying a week ──────────────────────────────────────────

/**
 * The changes that copy last week's shifts into this one. Only empty cells are
 * filled: nothing already planned, and no one's time off, is overwritten.
 * Days the store is closed are skipped.
 */
export function copyWeekChanges({ sourceCells, sourceWeekStart, targetWeekStart, cells, peopleIds, closures }) {
  const changes = [];
  const sourceDates = weekDates(sourceWeekStart);
  const targetDates = weekDates(targetWeekStart);
  for (const staffId of peopleIds) {
    sourceDates.forEach((sourceDate, i) => {
      const shift = sourceCells.get(cellKey(staffId, sourceDate))?.shift;
      if (!shift) return;
      const date = targetDates[i];
      if (closures.get(date)?.closed) return;
      const current = cells.get(cellKey(staffId, date)) ?? emptyCell();
      if (!isEmptyCell(current)) return;
      changes.push({
        staffId,
        date,
        before: current,
        after: { shift: { start: shift.start, end: shift.end, label: shift.label ?? '', away: Boolean(shift.away) }, off: null },
      });
    });
  }
  return changes;
}

// ─── Time off ────────────────────────────────────────────────

/**
 * Consecutive days off with the same kind and note, as one range each.
 * @param {Array<{staff_id:string, date:string, kind:string, note:string}>} rows
 */
export function groupTimeOff(rows) {
  const sorted = [...rows].sort((a, b) => a.staff_id.localeCompare(b.staff_id) || a.date.localeCompare(b.date));
  const ranges = [];
  for (const row of sorted) {
    const last = ranges[ranges.length - 1];
    if (
      last &&
      last.staffId === row.staff_id &&
      last.kind === row.kind &&
      last.note === (row.note ?? '') &&
      addDays(last.to, 1) === row.date
    ) {
      last.to = row.date;
      last.days += 1;
    } else {
      ranges.push({ staffId: row.staff_id, from: row.date, to: row.date, kind: row.kind, note: row.note ?? '', days: 1 });
    }
  }
  return ranges.sort((a, b) => a.from.localeCompare(b.from) || a.staffId.localeCompare(b.staffId));
}

/** "Nov 11 – 23", "Oct 26", "Sep 26 – Oct 3". */
export function dateRangeLabel(from, to) {
  const [, m1, d1] = from.split('-').map(Number);
  const [, m2, d2] = to.split('-').map(Number);
  if (from === to) return `${MONTH_SHORT[m1 - 1]} ${d1}`;
  if (m1 === m2) return `${MONTH_SHORT[m1 - 1]} ${d1} – ${d2}`;
  return `${MONTH_SHORT[m1 - 1]} ${d1} – ${MONTH_SHORT[m2 - 1]} ${d2}`;
}

export function daysBetween(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

// ─── Publishing ──────────────────────────────────────────────

/**
 * A week's cells in a fixed order, for publishing and for spotting what
 * changed since. Short keys keep the stored JSON small.
 */
export function snapshotCells(cells, dates) {
  const dateSet = new Set(dates);
  const out = [];
  for (const [key, cell] of cells) {
    const [s, d] = key.split('|');
    if (!dateSet.has(d) || isEmptyCell(cell)) continue;
    out.push({
      s,
      d,
      ...(cell.shift ? { a: cell.shift.start, b: cell.shift.end, l: cell.shift.label ?? '', w: cell.shift.away ? 1 : 0 } : {}),
      ...(cell.off ? { o: cell.off.kind, n: cell.off.note ?? '' } : {}),
    });
  }
  return out.sort((x, y) => x.s.localeCompare(y.s) || x.d.localeCompare(y.d));
}

export function cellsFromSnapshot(snapshot) {
  const cells = new Map();
  for (const row of snapshot ?? []) {
    cells.set(cellKey(row.s, row.d), {
      shift: 'a' in row ? { start: row.a, end: row.b, label: row.l ?? '', away: Boolean(row.w) } : null,
      off: row.o ? { kind: row.o, note: row.n ?? '' } : null,
    });
  }
  return cells;
}

/** Cell keys whose value differs from what staff were last shown. */
export function changedSincePublish(snapshot, cells, dates) {
  const published = cellsFromSnapshot(snapshot);
  const changed = new Set();
  const dateSet = new Set(dates);
  for (const key of new Set([...published.keys(), ...cells.keys()])) {
    if (!dateSet.has(key.split('|')[1])) continue;
    if (!sameCell(published.get(key) ?? emptyCell(), cells.get(key) ?? emptyCell())) changed.add(key);
  }
  return changed;
}

// ─── Clock-ins against the schedule ──────────────────────────

/**
 * How someone's time clock compares with their shift that day.
 * @param {{start:number|null, end:number|null} | null} shift
 * @param {Array<{in:number, out:number|null}>} punches store-local minutes
 * @param {{isPast:boolean, isToday:boolean, nowMinutes:number}} when
 * @returns {{kind:'on-time'|'late'|'no-show'|'working'|'unscheduled'|'none', minutes?:number, in?:number, out?:number|null}}
 */
export function clockStatus(shift, punches, when) {
  const sorted = [...punches].sort((a, b) => a.in - b.in);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const hasStart = shift && shift.start !== null && shift.start !== undefined && !shift.away;

  if (!first) {
    if (!hasStart) return { kind: 'none' };
    const due = when.isPast || (when.isToday && when.nowMinutes > shift.start + 15);
    return due ? { kind: 'no-show' } : { kind: 'none' };
  }
  if (!shift) return { kind: 'unscheduled', in: first.in, out: last.out };
  if (last.out === null && when.isToday) {
    const late = hasStart ? first.in - shift.start : 0;
    return { kind: 'working', in: first.in, out: null, minutes: late > LATE_GRACE_MINUTES ? late : 0 };
  }
  if (hasStart && first.in - shift.start > LATE_GRACE_MINUTES) {
    return { kind: 'late', minutes: first.in - shift.start, in: first.in, out: last.out };
  }
  return { kind: 'on-time', in: first.in, out: last.out };
}

// ─── Text for a group message ────────────────────────────────

export function weekText({ weekStart, people, cells, hoursByDate, closures, weekNote }) {
  const lines = [`Sunny & Ranney schedule, ${weekRangeLabel(weekStart)}`, ''];
  for (const date of weekDates(weekStart)) {
    const closure = closures.get(date);
    const working = people
      .map((p) => ({ p, shift: cells.get(cellKey(p.id, date))?.shift }))
      .filter((x) => x.shift)
      .sort((a, b) => (a.shift.start ?? 9999) - (b.shift.start ?? 9999))
      .map(({ p, shift }) => {
        const label = shift.label && shift.start !== null ? ` (${shift.label})` : '';
        return `${p.name} ${shiftShort(shift)}${label}`;
      });
    const off = people
      .filter((p) => cells.get(cellKey(p.id, date))?.off)
      .map((p) => {
        const kind = cells.get(cellKey(p.id, date)).off.kind;
        return `${p.name} ${kind === 'pto' ? 'PTO' : TIME_OFF_LABELS[kind].toLowerCase()}`;
      });
    const day = `${DAY_SHORT[weekdayOf(date)]} ${dayOfMonth(date)}`;
    const notes = [closure?.closed ? 'Store closed' : null, closure?.note || null].filter(Boolean).join(', ');
    const parts = [];
    if (notes) parts.push(`(${notes})`);
    if (working.length) parts.push(working.join(', '));
    else if (!hoursByDate.get(date)) parts.push(closure?.closed ? '' : 'Closed');
    else parts.push('Nobody scheduled');
    if (off.length) parts.push(`· ${off.join(', ')}`);
    lines.push(`${day}: ${parts.filter(Boolean).join(' ')}`.trimEnd());
  }
  if (weekNote?.trim()) lines.push('', weekNote.trim());
  return lines.join('\n');
}

// ─── Calendar feed (iCalendar, RFC 5545) ─────────────────────

function icsEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line at 75 octets without splitting a character. */
function fold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + n > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function icsUtc(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Store-local date and minutes → UTC ISO string. */
export function localToUtc(date, minutes) {
  if (minutes >= 1440) return localInputToUtc(`${addDays(date, 1)}T00:00`);
  return localInputToUtc(`${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
}

/**
 * @param {{name:string, now:string, events: Array<{uid:string, summary:string, description?:string, location?:string,
 *   start?:string, end?:string, date?:string, endDate?:string, sequence?:number}>}} calendar
 */
export function buildCalendar({ name, now, events }) {
  const stamp = icsUtc(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sunny & Ranney//Staff schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${stamp}`);
    if (event.date) {
      lines.push(`DTSTART;VALUE=DATE:${event.date.replace(/-/g, '')}`);
      lines.push(`DTEND;VALUE=DATE:${(event.endDate ?? addDays(event.date, 1)).replace(/-/g, '')}`);
      lines.push('TRANSP:TRANSPARENT');
    } else {
      lines.push(`DTSTART:${icsUtc(event.start)}`, `DTEND:${icsUtc(event.end)}`);
    }
    lines.push(`SUMMARY:${icsEscape(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
    if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
    if (event.sequence) lines.push(`SEQUENCE:${event.sequence}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
