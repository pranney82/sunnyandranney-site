import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCalendar,
  cellKey,
  cellToInput,
  changedSincePublish,
  clock,
  clockStatus,
  copyWeekChanges,
  coverage,
  dateRangeLabel,
  describeParse,
  groupTimeOff,
  hoursOn,
  localToUtc,
  parseCell,
  parsedToCell,
  quickPicks,
  snapshotCells,
  validateCell,
  weekAlerts,
  weekDates,
  weekRangeLabel,
  weekText,
  weekTotals,
} from './core.mjs';

const shift = (start, end, label = '', away = false) => ({ type: 'shift', start, end, label, away });
const H = (h, m = 0) => h * 60 + m;

// Every distinct entry from the store's 2026 schedule sheet reads correctly.
test('reads the shift times the sheet uses', () => {
  assert.deepEqual(parseCell('9-5'), shift(H(9), H(17)));
  assert.deepEqual(parseCell('10-5'), shift(H(10), H(17)));
  assert.deepEqual(parseCell('10:30-6'), shift(H(10, 30), H(18)));
  assert.deepEqual(parseCell('10-6'), shift(H(10), H(18)));
  assert.deepEqual(parseCell('10-4'), shift(H(10), H(16)));
  assert.deepEqual(parseCell('11-4'), shift(H(11), H(16)));
  assert.deepEqual(parseCell('12-4'), shift(H(12), H(16)));
  assert.deepEqual(parseCell('10-2'), shift(H(10), H(14)));
  assert.deepEqual(parseCell('3-6'), shift(H(15), H(18)));
  assert.deepEqual(parseCell('9-6'), shift(H(9), H(18)));
  assert.deepEqual(parseCell('10-3'), shift(H(10), H(15)));
  assert.deepEqual(parseCell('9-?'), shift(H(9), null));
  assert.deepEqual(parseCell('9-3*'), shift(H(9), H(15), '*'));
  assert.deepEqual(parseCell('9-? *'), shift(H(9), null, '*'));
});

test('reads days off, empty cells and tasks from the sheet', () => {
  assert.deepEqual(parseCell('OFF'), { type: 'off', kind: 'off', note: '' });
  assert.deepEqual(parseCell('PTO'), { type: 'off', kind: 'pto', note: '' });
  assert.deepEqual(parseCell('PT0'), { type: 'off', kind: 'pto', note: '' });
  assert.deepEqual(parseCell('vac Disney'), { type: 'off', kind: 'vacation', note: 'Disney' });
  assert.deepEqual(parseCell('Vacation'), { type: 'off', kind: 'vacation', note: '' });
  assert.deepEqual(parseCell('sick'), { type: 'off', kind: 'sick', note: '' });
  assert.deepEqual(parseCell('-'), { type: 'clear' });
  assert.deepEqual(parseCell('  '), { type: 'clear' });
  assert.deepEqual(parseCell('Mart'), shift(null, null, 'Mart', true));
  assert.deepEqual(parseCell('WH'), shift(null, null, 'WH', true));
  assert.deepEqual(parseCell('Set floor'), shift(null, null, 'Set floor', false));
  assert.deepEqual(parseCell('Drop off merch'), shift(null, null, 'Drop off merch', true));
});

test('reads labels next to times, either side', () => {
  assert.deepEqual(parseCell('Mart 9-5'), shift(H(9), H(17), 'Mart', true));
  assert.deepEqual(parseCell('9-1 set floor'), shift(H(9), H(13), 'set floor', false));
});

test('reads am/pm, 24-hour times and compact minutes', () => {
  assert.deepEqual(parseCell('9a-1p'), shift(H(9), H(13)));
  assert.deepEqual(parseCell('9:30 am - 2:15 pm'), shift(H(9, 30), H(14, 15)));
  assert.deepEqual(parseCell('930-5'), shift(H(9, 30), H(17)));
  assert.deepEqual(parseCell('13-17'), shift(H(13), H(17)));
  assert.deepEqual(parseCell('6a-2'), shift(H(6), H(14)));
  assert.deepEqual(parseCell('9 to 12'), shift(H(9), H(12)));
  assert.deepEqual(parseCell('4-9'), shift(H(16), H(21)));
  assert.deepEqual(parseCell('5p-12a'), shift(H(17), 1440));
});

test('open and close use the store’s hours that day', () => {
  const hours = { open: H(10), close: H(17) };
  assert.deepEqual(parseCell('open-close', hours), shift(H(10), H(17)));
  assert.deepEqual(parseCell('12-close', hours), shift(H(12), H(17)));
  assert.equal(parseCell('10-close', null).type, 'error');
});

test('refuses times it can’t place, with a reason', () => {
  assert.equal(parseCell('9').type, 'error');
  assert.match(parseCell('9').message, /end time/);
  assert.equal(parseCell('5p-9a').type, 'error');
  assert.equal(parseCell('25-5').type, 'error');
  assert.equal(parseCell('6a-11p').type, 'error');
});

test('the editor text reads back to the same shift', () => {
  const cases = [
    { shift: { start: H(9), end: H(17), label: '', away: false }, off: null },
    { shift: { start: H(10, 30), end: H(18), label: '', away: false }, off: null },
    { shift: { start: H(6), end: H(14), label: '', away: false }, off: null },
    { shift: { start: H(15), end: H(18), label: '', away: false }, off: null },
    { shift: { start: H(9), end: null, label: '', away: false }, off: null },
    { shift: { start: H(9), end: H(17), label: 'Mart', away: true }, off: null },
    { shift: { start: null, end: null, label: 'Set floor', away: false }, off: null },
    { shift: { start: H(17), end: 1440, label: '', away: false }, off: null },
    { shift: null, off: { kind: 'vacation', note: 'Disney' } },
    { shift: null, off: { kind: 'pto', note: '' } },
  ];
  for (const cell of cases) {
    const text = cellToInput(cell);
    assert.deepEqual(parsedToCell(parseCell(text)), cell, text);
  }
});

test('describes what it read in plain words', () => {
  assert.equal(describeParse(parseCell('9-5')), '9:00 AM – 5:00 PM · 8 hours');
  assert.equal(describeParse(parseCell('10:30-6')), '10:30 AM – 6:00 PM · 7.5 hours');
  assert.equal(describeParse(parseCell('pto')), 'PTO');
  assert.match(describeParse(parseCell('Mart')), /No hours/);
});

test('clock matches how the sheet writes times', () => {
  assert.equal(clock(H(9)), '9');
  assert.equal(clock(H(10, 30)), '10:30');
  assert.equal(clock(H(17)), '5');
  assert.equal(clock(H(12)), '12');
});

test('validates cells sent to the API', () => {
  assert.deepEqual(validateCell({ shift: { start: 540, end: 1020, label: ' Mart ', away: true }, off: null }), {
    shift: { start: 540, end: 1020, label: 'Mart', away: true },
    off: null,
  });
  assert.equal(typeof validateCell({ shift: { start: 1020, end: 540, label: '', away: false } }), 'string');
  assert.equal(typeof validateCell({ shift: { start: 0, end: 1440, label: '', away: false } }), 'string');
  assert.equal(typeof validateCell({ shift: { start: null, end: null, label: '', away: false } }), 'string');
  assert.equal(typeof validateCell({ shift: { start: 540.5, end: 1020, label: '', away: false } }), 'string');
  assert.equal(typeof validateCell({ off: { kind: 'holiday', note: '' } }), 'string');
  assert.deepEqual(validateCell({ shift: null, off: null }), { shift: null, off: null });
});

const STORE = {
  days: [
    { day: 'Monday', open: '10:00', close: '17:00', closed: true },
    { day: 'Tuesday', open: '10:00', close: '17:00', closed: false },
    { day: 'Wednesday', open: '10:00', close: '17:00', closed: false },
    { day: 'Thursday', open: '10:00', close: '17:00', closed: false },
    { day: 'Friday', open: '10:00', close: '17:00', closed: false },
    { day: 'Saturday', open: '10:00', close: '17:00', closed: false },
    { day: 'Sunday', open: '10:00', close: '17:00', closed: true },
  ],
  holidays: [
    { date: '2026-11-26', label: 'Thanksgiving', closed: true, open: '', close: '' },
    { date: '2026-12-24', label: 'Christmas Eve', closed: false, open: '10:00', close: '14:00' },
  ],
};

test('store hours: usual week, Google special hours, and closures set on the schedule', () => {
  assert.deepEqual(hoursOn('2026-11-17', STORE), { open: 600, close: 1020 });
  assert.equal(hoursOn('2026-11-16', STORE), null);
  assert.equal(hoursOn('2026-11-26', STORE), null);
  assert.deepEqual(hoursOn('2026-12-24', STORE), { open: 600, close: 840 });
  assert.equal(hoursOn('2026-11-17', STORE, { closed: 1 }), null);
  assert.equal(hoursOn('2026-11-17', null), null);
});

test('coverage finds the hours nobody is in the store', () => {
  const hours = { open: H(10), close: H(17) };
  const result = coverage([{ start: H(10), end: H(13) }, { start: H(14), end: H(18) }], hours);
  assert.deepEqual(result.gaps, [{ from: H(13), to: H(14) }]);
  assert.equal(result.peak, 1);
  assert.equal(result.from, H(10));
  assert.equal(result.to, H(18));
});

test('coverage ignores work away from the store and counts an open end to close', () => {
  const hours = { open: H(10), close: H(17) };
  assert.deepEqual(coverage([{ start: H(9), end: H(17), away: true }], hours).gaps, [{ from: H(10), to: H(17) }]);
  assert.deepEqual(coverage([{ start: H(9), end: null }], hours).gaps, []);
  assert.deepEqual(coverage([{ start: null, end: null, label: 'Mart' }], hours).gaps, [{ from: H(10), to: H(17) }]);
});

test('coverage stacks overlapping shifts', () => {
  const result = coverage([{ start: H(9), end: H(17) }, { start: H(10), end: H(17) }, { start: H(10), end: H(14) }], {
    open: H(10),
    close: H(17),
  });
  assert.deepEqual(result.segments, [
    { from: H(9), to: H(10), count: 1 },
    { from: H(10), to: H(14), count: 3 },
    { from: H(14), to: H(17), count: 2 },
  ]);
  assert.equal(result.peak, 3);
});

test('a closed day has no gaps', () => {
  assert.deepEqual(coverage([{ start: H(9), end: H(17) }], null).gaps, []);
  assert.deepEqual(coverage([], null).segments, []);
});

const people = [
  { id: 'a', name: 'Ava', overtimeEligible: false },
  { id: 'b', name: 'Ben', overtimeEligible: true },
];

function cellsFrom(entries) {
  return new Map(entries.map(([staff, date, value]) => [cellKey(staff, date), value]));
}

test('totals add up shifts and flag what can’t be counted', () => {
  const dates = weekDates('2026-11-01');
  const cells = cellsFrom([
    ['a', '2026-11-02', { shift: { start: H(9), end: H(17) }, off: null }],
    ['a', '2026-11-06', { shift: { start: H(10, 30), end: H(18) }, off: null }],
    ['b', '2026-11-06', { shift: { start: H(10), end: null }, off: null }],
    ['b', '2026-11-09', { shift: { start: H(10), end: H(17) }, off: null }],
    ['b', '2026-11-04', { shift: { start: null, end: null, label: 'Mart' }, off: null }],
  ]);
  const totals = weekTotals(people, dates, cells);
  assert.equal(totals.byPerson.get('a').minutes, 8 * 60 + 7.5 * 60);
  assert.deepEqual(totals.byPerson.get('b'), { minutes: 0, openEnded: 1, unhoured: 1, shifts: 2 });
  assert.equal(totals.week, 15.5 * 60);
  assert.equal(totals.byDate.get('2026-11-06'), 7.5 * 60);
});

test('alerts: gaps, conflicts, closures, overtime and loose ends', () => {
  const dates = weekDates('2026-11-15');
  const hoursByDate = new Map(dates.map((d) => [d, hoursOn(d, STORE)]));
  const closures = new Map([['2026-11-21', { closed: 1, note: 'Inventory' }]]);
  hoursByDate.set('2026-11-21', null);
  const cells = new Map();
  for (const d of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']) {
    cells.set(cellKey('a', d), { shift: { start: H(10), end: H(17) }, off: null });
  }
  for (const d of ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']) {
    cells.set(cellKey('b', d), { shift: { start: H(8), end: H(17), label: '', away: false }, off: null });
  }
  cells.set(cellKey('b', '2026-11-18'), { shift: { start: H(8), end: H(17) }, off: { kind: 'pto', note: '' } });
  cells.set(cellKey('a', '2026-11-21'), { shift: { start: H(10), end: H(17) }, off: null });
  const alerts = weekAlerts({ people, dates, cells, hoursByDate, closures, today: '2026-11-15' });
  const kinds = alerts.map((a) => a.kind);
  assert.ok(kinds.includes('conflict'));
  assert.ok(kinds.includes('closed'));
  assert.ok(kinds.includes('overtime'));
  assert.equal(alerts[0].severity, 'problem');
  assert.ok(!kinds.includes('gap'), 'every open hour is covered');
  assert.match(alerts.find((a) => a.kind === 'overtime').text, /Ben is at 45 hours, 5 of them overtime/);
  assert.match(alerts.find((a) => a.kind === 'conflict').text, /off \(PTO\)/);
});

test('alerts skip days already past', () => {
  const dates = weekDates('2026-11-15');
  const hoursByDate = new Map(dates.map((d) => [d, hoursOn(d, STORE)]));
  const alerts = weekAlerts({ people, dates, cells: new Map(), hoursByDate, closures: new Map(), today: '2026-11-20' });
  assert.deepEqual(
    alerts.map((a) => a.date),
    ['2026-11-20', '2026-11-21'],
  );
});

test('quick picks rank someone’s usual shifts, then the team’s', () => {
  const history = [
    { staff_id: 'a', start_min: H(9), end_min: H(17), label: '' },
    { staff_id: 'a', start_min: H(9), end_min: H(17), label: '' },
    { staff_id: 'a', start_min: H(10), end_min: H(17), label: '' },
    { staff_id: 'a', start_min: H(9), end_min: H(17), label: 'Mart' },
    { staff_id: 'b', start_min: H(10), end_min: H(17), label: '' },
    { staff_id: 'b', start_min: H(10), end_min: H(17), label: '' },
    { staff_id: 'b', start_min: H(11), end_min: H(16), label: '' },
  ];
  assert.deepEqual(
    quickPicks(history, 'a').map((p) => [p.start, p.end]),
    [
      [H(9), H(17)],
      [H(10), H(17)],
      [H(11), H(16)],
    ],
  );
  assert.deepEqual(
    quickPicks(history, 'new', 2).map((p) => [p.start, p.end]),
    [
      [H(10), H(17)],
      [H(9), H(17)],
    ],
  );
});

test('copying last week fills empty cells only', () => {
  const sourceCells = cellsFrom([
    ['a', '2026-11-09', { shift: { start: H(9), end: H(17), label: '', away: false }, off: null }],
    ['a', '2026-11-10', { shift: { start: H(9), end: H(17), label: '', away: false }, off: null }],
    ['a', '2026-11-11', { shift: null, off: { kind: 'off', note: '' } }],
    ['b', '2026-11-12', { shift: { start: H(10), end: H(17), label: '', away: false }, off: null }],
    ['b', '2026-11-14', { shift: { start: H(10), end: H(17), label: '', away: false }, off: null }],
  ]);
  const cells = cellsFrom([
    ['a', '2026-11-17', { shift: { start: H(12), end: H(17), label: '', away: false }, off: null }],
    ['b', '2026-11-19', { shift: null, off: { kind: 'vacation', note: '' } }],
  ]);
  const changes = copyWeekChanges({
    sourceCells,
    sourceWeekStart: '2026-11-08',
    targetWeekStart: '2026-11-15',
    cells,
    peopleIds: ['a', 'b'],
    closures: new Map([['2026-11-21', { closed: 1 }]]),
  });
  assert.deepEqual(
    changes.map((c) => `${c.staffId}|${c.date}`),
    ['a|2026-11-16'],
  );
  assert.equal(changes[0].after.shift.start, H(9));
});

test('time off groups consecutive days into ranges', () => {
  const rows = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-15'].map((date) => ({
    staff_id: 't',
    date,
    kind: 'vacation',
    note: '',
  }));
  rows.push({ staff_id: 'n', date: '2026-11-12', kind: 'pto', note: '' });
  rows.push({ staff_id: 't', date: '2026-11-14', kind: 'off', note: '' });
  const ranges = groupTimeOff(rows);
  assert.deepEqual(
    ranges.map((r) => `${r.staffId} ${r.from}..${r.to} ${r.kind} ${r.days}`),
    [
      't 2026-11-11..2026-11-13 vacation 3',
      'n 2026-11-12..2026-11-12 pto 1',
      't 2026-11-14..2026-11-14 off 1',
      't 2026-11-15..2026-11-15 vacation 1',
    ],
  );
  assert.equal(dateRangeLabel('2026-11-11', '2026-11-23'), 'Nov 11 – 23');
  assert.equal(dateRangeLabel('2026-09-26', '2026-10-03'), 'Sep 26 – Oct 3');
});

test('labels a week the way people say it', () => {
  assert.equal(weekRangeLabel('2026-11-15'), 'Nov 15 – 21');
  assert.equal(weekRangeLabel('2026-11-29'), 'Nov 29 – Dec 5');
  assert.equal(weekRangeLabel('2026-12-27'), 'Dec 27, 2026 – Jan 2, 2027');
});

test('publishing: a snapshot round-trips and changes since are found', () => {
  const dates = weekDates('2026-11-15');
  const cells = cellsFrom([
    ['a', '2026-11-16', { shift: { start: H(9), end: H(17), label: '', away: false }, off: null }],
    ['b', '2026-11-17', { shift: null, off: { kind: 'pto', note: '' } }],
    ['b', '2026-11-30', { shift: { start: H(9), end: H(17), label: '', away: false }, off: null }],
  ]);
  const snapshot = snapshotCells(cells, dates);
  assert.equal(snapshot.length, 2);
  assert.equal(changedSincePublish(snapshot, cells, dates).size, 0);
  const edited = new Map(cells);
  edited.set(cellKey('a', '2026-11-16'), { shift: { start: H(10), end: H(17), label: '', away: false }, off: null });
  edited.set(cellKey('a', '2026-11-18'), { shift: { start: H(10), end: H(17), label: '', away: false }, off: null });
  edited.delete(cellKey('b', '2026-11-17'));
  assert.deepEqual(
    [...changedSincePublish(snapshot, edited, dates)].sort(),
    ['a|2026-11-16', 'a|2026-11-18', 'b|2026-11-17'],
  );
});

test('clock-ins compared with the schedule', () => {
  const s = { start: H(10), end: H(17) };
  const past = { isPast: true, isToday: false, nowMinutes: 0 };
  assert.deepEqual(clockStatus(s, [{ in: H(10, 3), out: H(17) }], past), { kind: 'on-time', in: H(10, 3), out: H(17) });
  assert.deepEqual(clockStatus(s, [{ in: H(10, 14), out: H(17) }], past), {
    kind: 'late',
    minutes: 14,
    in: H(10, 14),
    out: H(17),
  });
  assert.deepEqual(clockStatus(s, [], past), { kind: 'no-show' });
  assert.deepEqual(clockStatus(s, [], { isPast: false, isToday: true, nowMinutes: H(10, 10) }), { kind: 'none' });
  assert.deepEqual(clockStatus(s, [], { isPast: false, isToday: true, nowMinutes: H(10, 20) }), { kind: 'no-show' });
  assert.equal(clockStatus(null, [{ in: H(11), out: H(13) }], past).kind, 'unscheduled');
  assert.equal(clockStatus(s, [{ in: H(9, 58), out: null }], { isPast: false, isToday: true, nowMinutes: H(12) }).kind, 'working');
  assert.deepEqual(clockStatus({ start: H(9), end: H(17), away: true }, [], past), { kind: 'none' });
});

test('text for a group message', () => {
  const dates = weekDates('2026-11-22');
  const hoursByDate = new Map(dates.map((d) => [d, hoursOn(d, STORE)]));
  const cells = cellsFrom([
    ['a', '2026-11-25', { shift: { start: H(10), end: H(16), label: '', away: false }, off: null }],
    ['b', '2026-11-25', { shift: { start: H(9), end: H(17), label: 'Set floor', away: false }, off: null }],
    ['b', '2026-11-27', { shift: null, off: { kind: 'pto', note: '' } }],
  ]);
  const closures = new Map([['2026-11-26', { closed: 1, note: 'Thanksgiving' }]]);
  const text = weekText({ weekStart: '2026-11-22', people, cells, hoursByDate, closures, weekNote: 'Black Friday!' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Sunny & Ranney schedule, Nov 22 – 28');
  assert.equal(lines[2], 'Sun 22: Closed');
  assert.equal(lines[5], 'Wed 25: Ben 9–5 (Set floor), Ava 10–4');
  assert.equal(lines[6], 'Thu 26: (Store closed, Thanksgiving)');
  assert.equal(lines[7], 'Fri 27: Nobody scheduled · Ben PTO');
  assert.equal(lines.at(-1), 'Black Friday!');
});

test('calendar feed follows RFC 5545', () => {
  const start = localToUtc('2026-11-17', H(9));
  const end = localToUtc('2026-11-17', H(17));
  assert.equal(start, '2026-11-17T14:00:00.000Z');
  assert.equal(localToUtc('2026-07-14', H(9)), '2026-07-14T13:00:00.000Z');
  assert.equal(localToUtc('2026-11-17', 1440), '2026-11-18T05:00:00.000Z');
  const ics = buildCalendar({
    name: 'Ava at Sunny & Ranney',
    now: '2026-11-07T12:00:00.000Z',
    events: [
      {
        uid: 'x@sunnyandranney.com',
        start,
        end,
        summary: 'Work 9–5',
        description: 'Also working: Ben 10–5, and a long line that has to be folded because it runs well past seventy-five octets',
        sequence: 2,
      },
      { uid: 'y@sunnyandranney.com', date: '2026-11-20', summary: 'PTO' },
    ],
  });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.includes('DTSTART:20261117T140000Z'));
  assert.ok(ics.includes('DTEND:20261117T220000Z'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261120'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261121'));
  assert.ok(ics.includes('Ben 10–5\\, and'));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});
