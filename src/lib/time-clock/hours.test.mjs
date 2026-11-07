import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  classifyEntries,
  isIsoDate,
  localDate,
  localInputToUtc,
  minutesToHours,
  utcToLocalInput,
  workedMinutes,
  workweekStart,
} from './hours.mjs';

function shift(id, day, hours, staff_id = 'a', overtime_eligible = 1) {
  const clock_in_at = localInputToUtc(`${day}T09:00`);
  const clock_out_at = new Date(Date.parse(clock_in_at) + hours * 3600000).toISOString();
  return { id, staff_id, clock_in_at, clock_out_at, overtime_eligible };
}

test('localDate uses the store day, not the UTC day', () => {
  assert.equal(localDate('2026-11-06T03:30:00.000Z'), '2026-11-05');
});

test('localInputToUtc applies daylight and standard offsets', () => {
  assert.equal(localInputToUtc('2026-07-01T10:00'), '2026-07-01T14:00:00.000Z');
  assert.equal(localInputToUtc('2026-12-01T10:00'), '2026-12-01T15:00:00.000Z');
});

test('localInputToUtc round-trips across both DST changes', () => {
  for (const value of ['2026-03-08T01:30', '2026-03-08T03:30', '2026-11-01T00:30', '2026-11-01T03:30']) {
    assert.equal(utcToLocalInput(localInputToUtc(value)), value);
  }
});

test('localInputToUtc refuses the skipped DST hour and bad input', () => {
  assert.equal(localInputToUtc('2026-03-08T02:30'), null);
  assert.equal(localInputToUtc('2026-02-31T10:00'), null);
  assert.equal(localInputToUtc('not a date'), null);
  assert.equal(localInputToUtc(undefined), null);
});

test('isIsoDate rejects impossible dates', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-2-3'), false);
});

test('addDays crosses months and DST without drifting', () => {
  assert.equal(addDays('2026-10-31', 7), '2026-11-07');
  assert.equal(addDays('2026-03-01', 7), '2026-03-08');
  assert.equal(addDays('2026-11-05', -5), '2026-10-31');
});

test('workweekStart finds the Sunday before, and honors another start day', () => {
  assert.equal(workweekStart('2026-11-05'), '2026-11-01');
  assert.equal(workweekStart('2026-11-01'), '2026-11-01');
  assert.equal(workweekStart('2026-11-05', 1), '2026-11-02');
});

test('workedMinutes rounds to the nearest minute', () => {
  assert.equal(workedMinutes('2026-11-05T14:00:00.000Z', '2026-11-05T14:00:29.000Z'), 0);
  assert.equal(workedMinutes('2026-11-05T14:00:00.000Z', '2026-11-05T14:00:31.000Z'), 1);
});

test('a DST shift is paid for time actually worked, not the wall clock', () => {
  const clockIn = localInputToUtc('2026-11-01T00:30');
  const clockOut = localInputToUtc('2026-11-01T03:30');
  assert.equal(workedMinutes(clockIn, clockOut), 240);
});

test('minutesToHours gives three decimals', () => {
  assert.equal(minutesToHours(90), '1.500');
  assert.equal(minutesToHours(20), '0.333');
});

test('exactly 40 hours has no overtime', () => {
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const result = classifyEntries(days.map((day, i) => shift(String(i), day, 8)));
  for (const value of result.values()) assert.equal(value.overtimeMinutes, 0);
});

test('overtime lands on the shift that crosses 40 hours, and later shifts', () => {
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const entries = days.map((day, i) => shift(String(i), day, 9));
  const result = classifyEntries(entries);
  assert.deepEqual(
    [...result.values()].map((v) => v.overtimeMinutes),
    [0, 0, 0, 0, 300],
  );
  assert.equal(result.get('4').regularMinutes, 240);
});

test('every minute after 40 hours is overtime', () => {
  const entries = [
    shift('1', '2026-11-02', 40),
    shift('2', '2026-11-04', 3),
  ];
  const result = classifyEntries(entries);
  assert.equal(result.get('2').overtimeMinutes, 180);
  assert.equal(result.get('2').regularMinutes, 0);
});

test('workweeks do not add together', () => {
  const entries = [shift('1', '2026-11-06', 30), shift('2', '2026-11-08', 30)];
  const result = classifyEntries(entries);
  assert.equal(result.get('1').overtimeMinutes, 0);
  assert.equal(result.get('2').overtimeMinutes, 0);
  assert.notEqual(result.get('1').weekStart, result.get('2').weekStart);
});

test('hours are counted per person', () => {
  const entries = [shift('1', '2026-11-02', 30, 'a'), shift('2', '2026-11-03', 30, 'b')];
  for (const value of classifyEntries(entries).values()) assert.equal(value.overtimeMinutes, 0);
});

test('overtime-exempt staff never get overtime', () => {
  const result = classifyEntries([shift('1', '2026-11-02', 50, 'a', 0)]);
  assert.equal(result.get('1').overtimeMinutes, 0);
  assert.equal(result.get('1').regularMinutes, 3000);
});

test('open shifts are ignored and classification ignores input order', () => {
  const late = shift('late', '2026-11-05', 10);
  const early = shift('early', '2026-11-02', 35);
  const open = { id: 'open', staff_id: 'a', clock_in_at: late.clock_out_at, clock_out_at: null, overtime_eligible: 1 };
  const result = classifyEntries([open, late, early]);
  assert.equal(result.has('open'), false);
  assert.equal(result.get('early').overtimeMinutes, 0);
  assert.equal(result.get('late').overtimeMinutes, 300);
});

test('adding a later shift never reclassifies an earlier one', () => {
  const first = [shift('1', '2026-11-02', 38)];
  const before = classifyEntries(first).get('1');
  const after = classifyEntries([...first, shift('2', '2026-11-05', 8)]).get('1');
  assert.deepEqual(after, before);
});
