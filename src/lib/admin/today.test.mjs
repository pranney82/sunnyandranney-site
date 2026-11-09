import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToday, floorStatus, localMinutes, suggestClockOut } from './today.mjs';

// Thursday Nov 12, 2026, 2:00 PM in the store (EST is UTC-5). The workweek began Sunday Nov 8.
const NOW = '2026-11-12T19:00:00.000Z';
const at = (day, hour, minute = 0) => new Date(Date.UTC(2026, 10, day, hour + 5, minute)).toISOString();

let n = 0;
const entry = (staff, inDay, inHour, outDay, outHour, extra = {}) => ({
  id: `e${++n}`,
  version: 1,
  staff_id: staff,
  display_name: { dana: 'Dana Ruiz', tom: 'Tom Avery', sam: 'Sam Ortiz', lena: 'Lena Park' }[staff],
  email: staff === 'sam' ? 'sam@example.com' : null,
  overtime_eligible: 1,
  clock_in_at: at(inDay, inHour),
  clock_out_at: outDay ? at(outDay, outHour) : null,
  status: 'pending',
  push_state: null,
  ...extra,
});
const people = [
  { id: 'dana', display_name: 'Dana Ruiz' },
  { id: 'tom', display_name: 'Tom Avery' },
  { id: 'sam', display_name: 'Sam Ortiz' },
  { id: 'lena', display_name: 'Lena Park' },
];

test('localMinutes reads store time, not UTC', () => {
  assert.equal(localMinutes(NOW), 14 * 60);
});

test('an open shift from an earlier day is a missed clock-out; one from today is someone working', () => {
  const t = buildToday({
    entries: [entry('dana', 11, 10, null), entry('tom', 12, 9, null)],
    people,
    schedule: [],
    now: NOW,
    myEmail: 'sam@example.com',
  });
  assert.deepEqual(t.missedClockOuts.map((x) => x.name), ['Dana Ruiz']);
  assert.deepEqual(t.onClock.map((x) => x.name), ['Tom Avery']);
});

test('clean shifts can be approved together, long ones need a look, and your own are left for another manager', () => {
  const t = buildToday({
    entries: [
      entry('dana', 9, 10, 9, 18),
      entry('tom', 10, 9, 10, 23),
      entry('sam', 10, 9, 10, 17),
      entry('dana', 8, 10, 8, 17, { status: 'approved' }),
      entry('tom', 9, 10, 9, 17, { push_state: 'pushed' }),
    ],
    people,
    schedule: [],
    now: NOW,
    myEmail: 'Sam@Example.com',
  });
  assert.deepEqual(t.ready.map((x) => x.name), ['Dana Ruiz']);
  assert.deepEqual(t.needsLook.map((x) => [x.name, x.reason]), [['Tom Avery', 'long']]);
});

test("overtime shows up before it happens: hours worked plus what's still scheduled", () => {
  const t = buildToday({
    entries: [
      entry('dana', 8, 9, 8, 17, { status: 'approved' }),
      entry('dana', 9, 9, 9, 17, { status: 'approved' }),
      entry('dana', 10, 9, 10, 17, { status: 'approved' }),
      entry('dana', 11, 9, 11, 17),
      entry('tom', 9, 10, 9, 18),
    ],
    people,
    schedule: [
      { staff_id: 'dana', date: '2026-11-13', start_min: 9 * 60, end_min: 17 * 60, away: 0 },
      { staff_id: 'dana', date: '2026-11-14', start_min: 9 * 60, end_min: 17 * 60, away: 0 },
      { staff_id: 'tom', date: '2026-11-13', start_min: 12 * 60, end_min: 20 * 60, away: 0 },
    ],
    now: NOW,
    myEmail: '',
  });
  const dana = t.week.find((p) => p.staffId === 'dana');
  assert.equal(dana.workedMinutes, 32 * 60);
  assert.equal(dana.scheduledMinutes, 16 * 60);
  assert.equal(dana.overtimeRisk, true);
  assert.equal(t.week.find((p) => p.staffId === 'tom').overtimeRisk, false);
  assert.equal(t.week[0].staffId, 'dana');
});

test("today's floor compares the schedule with the clock", () => {
  const t = buildToday({
    entries: [entry('dana', 12, 10, null), entry('tom', 12, 9, null)],
    people,
    schedule: [
      { staff_id: 'dana', date: '2026-11-12', start_min: 9 * 60, end_min: 17 * 60, away: 0 },
      { staff_id: 'tom', date: '2026-11-12', start_min: 9 * 60, end_min: 17 * 60, away: 0 },
      { staff_id: 'sam', date: '2026-11-12', start_min: 12 * 60, end_min: 20 * 60, away: 0 },
      { staff_id: 'lena', date: '2026-11-12', start_min: 16 * 60, end_min: 20 * 60, away: 0 },
    ],
    now: NOW,
    myEmail: '',
  });
  const kind = Object.fromEntries(t.floor.map((p) => [p.staffId, p.status.kind]));
  assert.deepEqual(kind, { dana: 'late', tom: 'working', sam: 'no-show', lena: 'scheduled' });
  assert.deepEqual(t.lateOrMissing.map((p) => p.staffId).sort(), ['dana', 'sam']);
});

test('floorStatus: grace minutes, unscheduled work, and a finished shift', () => {
  assert.equal(floorStatus({ start: 540, end: 1020, away: false }, [{ in: 544, out: null }], 600).kind, 'working');
  assert.equal(floorStatus({ start: 540, end: 1020, away: false }, [{ in: 546, out: null }], 600).kind, 'late');
  assert.equal(floorStatus(null, [{ in: 600, out: null }], 660).unscheduled, true);
  assert.equal(floorStatus({ start: 540, end: 1020, away: false }, [{ in: 540, out: 1020 }], 1100).kind, 'done');
  assert.equal(floorStatus({ start: 540, end: 1020, away: true }, [], 700).kind, 'scheduled');
});

test('a forgotten clock-out is offered the scheduled end first, then the usual time for that weekday', () => {
  // Wednesday Nov 11, 9:00 AM. Usual ends: three Wednesdays at 5:00 PM, other days at 8:00 PM.
  const clockInAt = at(11, 9);
  const usualEnds = [
    { weekday: 3, minutes: 17 * 60 },
    { weekday: 3, minutes: 17 * 60 + 10 },
    { weekday: 3, minutes: 16 * 60 + 50 },
    { weekday: 5, minutes: 20 * 60 },
    { weekday: 6, minutes: 20 * 60 },
  ];
  const scheduled = suggestClockOut({ clockInAt, scheduledEnd: 18 * 60, usualEnds, now: NOW });
  assert.deepEqual([scheduled.local, scheduled.source], ['2026-11-11T18:00', 'schedule']);
  assert.equal(scheduled.at, at(11, 18));

  const usual = suggestClockOut({ clockInAt, scheduledEnd: null, usualEnds, now: NOW });
  assert.deepEqual([usual.local, usual.source], ['2026-11-11T17:00', 'usual']);

  // Too few clock-outs to know what's usual.
  assert.equal(suggestClockOut({ clockInAt, scheduledEnd: null, usualEnds: usualEnds.slice(3), now: NOW }), null);
  // A scheduled end before the clock-in falls back to the usual time.
  assert.equal(suggestClockOut({ clockInAt: at(11, 19), scheduledEnd: 18 * 60, usualEnds: [], now: NOW }), null);
  // Never a time that hasn't happened yet: today's shift ends at 5 PM, and it's 2 PM.
  assert.equal(suggestClockOut({ clockInAt: at(12, 1), scheduledEnd: 17 * 60, usualEnds: [], now: NOW }), null);
  // Never longer than the 16 hours the hours API allows.
  assert.equal(suggestClockOut({ clockInAt: at(11, 6), scheduledEnd: 23 * 60, usualEnds: [], now: NOW }), null);
});

test('missed clock-outs carry a suggestion, but not for your own shift', () => {
  const t = buildToday({
    entries: [entry('dana', 11, 10, null), entry('sam', 11, 10, null)],
    people,
    schedule: [{ staff_id: 'dana', date: '2026-11-11', start_min: 10 * 60, end_min: 18 * 60, away: 0 }],
    now: NOW,
    myEmail: 'sam@example.com',
  });
  const byName = Object.fromEntries(t.missedClockOuts.map((m) => [m.name, m]));
  assert.equal(byName['Dana Ruiz'].suggestion.local, '2026-11-11T18:00');
  assert.equal(byName['Sam Ortiz'].isSelf, true);
  assert.equal(byName['Sam Ortiz'].suggestion, null);
});
