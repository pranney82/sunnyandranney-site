#!/usr/bin/env node
/**
 * Brings the store's old Google Sheet schedule into the admin's schedule.
 *
 *   node scripts/import-schedule-sheet.mjs <sheet.json> --local [--create-missing] [--apply]
 *   node scripts/import-schedule-sheet.mjs <sheet.json> --remote
 *
 * <sheet.json> is a transcription of the sheet's month tabs (kept outside this
 * public repo: it names staff). The sheet repeats a week on two tabs where
 * months meet, and the copies don't always agree, so each day is taken from
 * the tab for that day's month, and from the other tab only when that one is
 * blank. The script prints what it found, writes SQL, and applies it only to a
 * local database. For production it prints the command for a person to run
 * after reading the SQL.
 *
 * Options: --config <wrangler.toml>, --persist-to <dir> (local state),
 * --out <file.sql>, --create-missing (add staff the database doesn't have yet).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fallbackHours from '../src/content/settings/hours.json' with { type: 'json' };
import {
  cellKey,
  daysBetween,
  hoursOn,
  parseCell,
  parsedToCell,
  shiftMinutes,
  snapshotCells,
  weekDates,
  weekdayOf,
} from '../src/lib/schedule/core.mjs';
import { addDays } from '../src/lib/time-clock/hours.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a) => a.endsWith('.json'));
const target = flag('--remote') ? 'remote' : flag('--local') ? 'local' : null;
if (!file || !target) {
  console.error('Usage: node scripts/import-schedule-sheet.mjs <sheet.json> --local|--remote [--create-missing] [--apply]');
  process.exit(1);
}
if (flag('--apply') && target === 'remote') {
  console.error('Refusing --apply on production. Read the SQL, then run the printed command yourself.');
  process.exit(1);
}

const sheet = JSON.parse(readFileSync(file, 'utf8'));
const ACTOR = 'import: Google Sheet';
const now = new Date().toISOString();

// ─── Merge the tabs ─────────────────────────────────────────

/** Every value the sheet gives each person on each day, newest tab order kept. */
const values = new Map(); // key person|date → [{tab, month, raw}]
const rowNotes = new Map(); // person|weekStart → note
const weekNotes = new Map(); // weekStart → Set(note)
const typed = []; // weeks where the sheet typed totals by hand

for (const tab of sheet.tabs) {
  for (const week of tab.weeks) {
    const dates = weekDates(week.start);
    if (week.note) {
      if (!weekNotes.has(week.start)) weekNotes.set(week.start, new Set());
      weekNotes.get(week.start).add(week.note.trim());
    }
    for (const [person, row] of Object.entries(week.rows ?? {})) {
      if (week.rowNotes?.[person]) rowNotes.set(`${person}|${week.start}`, week.rowNotes[person]);
      dates.forEach((date, i) => {
        const raw = (row[i] ?? '').trim();
        if (raw === '') return;
        const key = `${person}|${date}`;
        if (!values.has(key)) values.set(key, []);
        values.get(key).push({ tab: tab.tab, month: tab.month, raw, weekStart: week.start });
      });
    }
    if (week.typedHours) typed.push({ weekStart: week.start, perPerson: week.typedHours, total: week.typedTotal });
  }
}

const normalize = (raw, date) => {
  const v = raw.trim().toUpperCase().replace('PT0', 'PTO');
  if (v === '-' || v === '*') return '';
  if (v === 'OFF' && weekdayOf(date) === 0) return '';
  return v;
};

const disagreements = [];
const chosen = new Map(); // person|date → {raw, weekStart}
for (const [key, list] of values) {
  const date = key.split('|')[1];
  const owner = list.find((v) => v.month === date.slice(0, 7));
  const pick = owner ?? list[0];
  chosen.set(key, pick);
  const distinct = new Set(list.map((v) => normalize(v.raw, date)));
  if (distinct.size > 1) disagreements.push({ key, list });
}
// A day one tab fills in and the other leaves blank is also a disagreement.
const tabWeeks = new Map();
for (const tab of sheet.tabs) for (const week of tab.weeks) {
  if (!tabWeeks.has(week.start)) tabWeeks.set(week.start, []);
  tabWeeks.get(week.start).push({ tab: tab.tab, filled: Object.keys(week.rows ?? {}).length > 0 });
}

// ─── Read each value ────────────────────────────────────────

const overrides = sheet.cellOverrides ?? {};
const cells = new Map(); // person|date → {shift, off}
const unread = [];
for (const [key, pick] of chosen) {
  const [person, date] = key.split('|');
  const raw = pick.raw;
  const override = overrides[raw];
  if (override === 'skip') continue;
  if (override) {
    cells.set(key, { shift: override.shift ?? null, off: override.off ?? null });
    continue;
  }
  if (raw === '-' || raw === '*') continue;
  if (/^off$/i.test(raw)) {
    // Sundays the store is closed and everyone is "OFF"; that's not time off.
    if (weekdayOf(date) === 0) continue;
    const vacation = rowNotes.get(`${person}|${pick.weekStart}`) === 'VACATION';
    cells.set(key, { shift: null, off: { kind: vacation ? 'vacation' : 'off', note: '' } });
    continue;
  }
  const cell = parsedToCell(parseCell(raw, hoursOn(date, fallbackHours)));
  if (!cell) {
    unread.push(`${person} ${date}: "${raw}"`);
    continue;
  }
  if (cell.off && cell.off.kind === 'off' && weekdayOf(date) === 0) continue;
  cells.set(key, cell);
}

// Time off the sheet listed in its "Time Off Request" box, on every tab.
const requests = new Map();
for (const tab of sheet.tabs) for (const [person, from, to] of tab.timeOff ?? []) requests.set(`${person}|${from}|${to}`, { person, from, to });
const conflicts = [];
for (const { person, from, to } of requests.values()) {
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const key = `${person}|${date}`;
    const cell = cells.get(key) ?? { shift: null, off: null };
    if (cell.shift && !cell.off) conflicts.push(`${person} is scheduled ${cell.shift.start === null ? cell.shift.label : `${cell.shift.start / 60}:00`} on ${date}, inside their time off ${from} to ${to}`);
    if (!cell.off) cell.off = { kind: 'off', note: '' };
    cells.set(key, cell);
  }
}

// ─── What the sheet got wrong ───────────────────────────────

console.log(`\nRead ${sheet.tabs.length} tabs, ${chosen.size} filled cells, ${requests.size} time-off requests.\n`);

const repeated = [...tabWeeks.entries()].filter(([, tabs]) => tabs.length > 1);
console.log(`Weeks that appear on two tabs: ${repeated.length}`);
for (const [week, tabs] of repeated) {
  const inWeek = disagreements.filter((d) => weekDates(week).includes(d.key.split('|')[1]));
  const blank = tabs.filter((t) => !t.filled).map((t) => t.tab);
  const say = blank.length ? `blank on ${blank.join(', ')}` : inWeek.length ? `${inWeek.length} cells differ` : 'match';
  console.log(`  ${week}: ${tabs.map((t) => t.tab).join(' + ')} → ${say}`);
  for (const d of inWeek) console.log(`      ${d.key}: ${d.list.map((v) => `${v.tab}="${v.raw}"`).join(' vs ')}`);
}

console.log('\nTotals typed by hand vs. the hours in the cells:');
for (const t of typed) {
  let sum = 0;
  const lines = [];
  for (const [person, typedHours] of Object.entries(t.perPerson)) {
    let minutes = 0;
    for (const date of weekDates(t.weekStart)) minutes += shiftMinutes(cells.get(`${person}|${date}`)?.shift ?? null);
    sum += typedHours;
    if (minutes / 60 !== typedHours) lines.push(`${person} typed ${typedHours}, cells ${minutes / 60}`);
  }
  const mark = t.total !== undefined && t.total !== sum ? `  ← week total typed ${t.total}, people add to ${sum}` : '';
  console.log(`  ${t.weekStart}: ${lines.length ? lines.join('; ') : 'all match'}${mark}`);
}

console.log(`\nShifts inside requested time off: ${conflicts.length}`);
for (const c of conflicts) console.log(`  ${c}`);
if (unread.length) {
  console.log(`\nCouldn't read ${unread.length} cells (left out):`);
  for (const u of unread) console.log(`  ${u}`);
}

// ─── Staff in the database ──────────────────────────────────

const wranglerArgs = ['d1', 'execute', 'sunnyandranney-db', `--${target}`];
if (option('--config')) wranglerArgs.push('-c', option('--config'));
if (option('--persist-to')) wranglerArgs.push('--persist-to', option('--persist-to'));

function query(sql) {
  const out = execFileSync('npx', ['wrangler', ...wranglerArgs, '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out)[0].results;
}

const staff = query('SELECT id, display_name FROM staff');
const idFor = new Map();
const missing = [];
for (const person of sheet.people) {
  const lower = person.toLowerCase();
  const match = staff.filter((s) => {
    const name = s.display_name.toLowerCase();
    return name === lower || name.split(/\s+/)[0] === lower;
  });
  if (match.length === 1) idFor.set(person, match[0].id);
  else if (match.length > 1) {
    console.error(`\n"${person}" matches more than one person on staff: ${match.map((m) => m.display_name).join(', ')}. Rename one and run again.`);
    process.exit(1);
  } else missing.push(person);
}
if (missing.length && !flag('--create-missing')) {
  console.error(`\nNot on staff yet: ${missing.join(', ')}. Add them on the Staff page, or pass --create-missing.`);
  process.exit(1);
}
for (const person of missing) idFor.set(person, crypto.randomUUID());
console.log(`\nStaff: ${sheet.people.map((p) => `${p}${missing.includes(p) ? ' (new)' : ''}`).join(', ')}`);

// ─── SQL ────────────────────────────────────────────────────

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sql = ['-- Schedule import from the Google Sheet. Review before running on production.'];

for (const person of missing) {
  sql.push(
    `INSERT INTO staff (id, display_name, overtime_eligible, active, store_staff, created_at, updated_at) VALUES (${q(idFor.get(person))}, ${q(person)}, 1, 1, 1, ${q(now)}, ${q(now)});`,
  );
}
sheet.people.forEach((person, i) => {
  sql.push(`INSERT INTO schedule_people (staff_id, position, added_at) VALUES (${q(idFor.get(person))}, ${i + 1}, ${q(now)}) ON CONFLICT (staff_id) DO NOTHING;`);
});

const byId = new Map();
let shiftCount = 0;
let offCount = 0;
for (const [key, cell] of cells) {
  const [person, date] = key.split('|');
  const staffId = idFor.get(person);
  if (!staffId) continue;
  byId.set(cellKey(staffId, date), cell);
  if (cell.shift) {
    shiftCount += 1;
    const s = cell.shift;
    sql.push(
      `INSERT INTO schedule_shifts (staff_id, date, start_min, end_min, label, away, rev, updated_by, updated_at) VALUES (${q(staffId)}, ${q(date)}, ${q(s.start)}, ${q(s.end)}, ${q(s.label ?? '')}, ${s.away ? 1 : 0}, lower(hex(randomblob(8))), ${q(ACTOR)}, ${q(now)}) ON CONFLICT (staff_id, date) DO UPDATE SET start_min = excluded.start_min, end_min = excluded.end_min, label = excluded.label, away = excluded.away, rev = excluded.rev, updated_by = excluded.updated_by, updated_at = excluded.updated_at;`,
    );
  }
  if (cell.off) {
    offCount += 1;
    sql.push(
      `INSERT INTO schedule_time_off (staff_id, date, kind, note, rev, updated_by, updated_at) VALUES (${q(staffId)}, ${q(date)}, ${q(cell.off.kind)}, ${q(cell.off.note ?? '')}, lower(hex(randomblob(8))), ${q(ACTOR)}, ${q(now)}) ON CONFLICT (staff_id, date) DO UPDATE SET kind = excluded.kind, note = excluded.note, rev = excluded.rev, updated_by = excluded.updated_by, updated_at = excluded.updated_at;`,
    );
  }
}

for (const day of sheet.days ?? []) {
  sql.push(
    `INSERT INTO schedule_days (date, note, closed, updated_by, updated_at) VALUES (${q(day.date)}, ${q(day.note)}, ${day.closed ? 1 : 0}, ${q(ACTOR)}, ${q(now)}) ON CONFLICT (date) DO UPDATE SET note = excluded.note, closed = excluded.closed, updated_by = excluded.updated_by, updated_at = excluded.updated_at;`,
  );
}

// Every week staff could already see in the sheet goes in as published.
const weeks = [...new Set([...tabWeeks.keys()])].sort();
for (const week of weeks) {
  const snapshot = snapshotCells(byId, weekDates(week));
  const note = [...(weekNotes.get(week) ?? [])].join(' · ');
  if (!snapshot.length && !note) continue;
  sql.push(
    `INSERT INTO schedule_weeks (week_start, note, published_json, published_at, published_by, updated_by, updated_at) VALUES (${q(week)}, ${q(note)}, ${q(JSON.stringify(snapshot))}, ${q(now)}, ${q(ACTOR)}, ${q(ACTOR)}, ${q(now)}) ON CONFLICT (week_start) DO UPDATE SET note = excluded.note, published_json = excluded.published_json, published_at = excluded.published_at, published_by = excluded.published_by, updated_by = excluded.updated_by, updated_at = excluded.updated_at;`,
  );
}

sql.push(
  `INSERT INTO schedule_events (actor, action, after_json, created_at) VALUES (${q(ACTOR)}, 'import', ${q(JSON.stringify({ shifts: shiftCount, timeOff: offCount, weeks: weeks.length }))}, ${q(now)});`,
);

const out = option('--out') ?? join(tmpdir(), `schedule-import-${Date.now()}.sql`);
writeFileSync(out, sql.join('\n') + '\n');
console.log(`\nWrote ${out}: ${shiftCount} shifts, ${offCount} days off, ${(sheet.days ?? []).length} day notes, ${weeks.length} weeks.`);

const run = ['npx', 'wrangler', ...wranglerArgs, '--file', out];
if (flag('--apply')) {
  execFileSync(run[0], run.slice(1), { stdio: 'inherit' });
  console.log('Applied.');
} else {
  console.log(`\nTo apply: ${run.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
}

// Days between the first and last date, as a sanity check on what's covered.
const all = [...cells.keys()].map((k) => k.split('|')[1]).sort();
if (all.length) console.log(`Covers ${all[0]} to ${all.at(-1)} (${daysBetween(all[0], all.at(-1)) + 1} days).`);
