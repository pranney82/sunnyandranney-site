import assert from 'node:assert/strict';
import test from 'node:test';
import { compensationName, groupPayRuns, payLineFrom, payRunFrom, readPayrollList, toCents } from './gusto-pay.mjs';

test('readPayrollList tells an empty list from an unreadable response', () => {
  assert.deepEqual(readPayrollList([]), { payrolls: [], recognized: true });
  assert.equal(readPayrollList({ payrolls: [{}] }).payrolls.length, 1);
  assert.equal(readPayrollList({ surprise: [] }).recognized, false);
  assert.equal(readPayrollList(null).recognized, false);
});

test('payRunFrom reads a regular payroll', () => {
  const run = payRunFrom({
    payroll_uuid: 'p1',
    check_date: '2026-10-30',
    pay_period: { start_date: '2026-10-11', end_date: '2026-10-24' },
    reversal_payroll_uuids: [],
  });
  assert.deepEqual(run, {
    payrollUuid: 'p1',
    checkDate: '2026-10-30',
    periodStart: '2026-10-11',
    periodEnd: '2026-10-24',
    kind: 'regular',
    reversed: false,
  });
});

test('payRunFrom labels off-cycle payrolls and both sides of a reversal', () => {
  assert.equal(payRunFrom({ uuid: 'p', check_date: '2026-01-02', off_cycle: true, off_cycle_reason: 'Bonus' }).kind, 'off_cycle');
  assert.equal(payRunFrom({ uuid: 'p', check_date: '2026-01-02', off_cycle: true, off_cycle_reason: 'Reversal' }).kind, 'reversal');
  assert.equal(payRunFrom({ uuid: 'p', check_date: '2026-01-02', off_cycle: true, off_cycle_reason: 'Benefit reversal' }).kind, 'reversal');
  assert.equal(payRunFrom({ uuid: 'p', check_date: '2026-01-02', reversal_payroll_uuids: ['r'] }).reversed, true);
});

test('payRunFrom refuses a payroll with no id or check date', () => {
  assert.equal(payRunFrom({ check_date: '2026-01-02' }), null);
  assert.equal(payRunFrom({ uuid: 'p' }), null);
  assert.equal(payRunFrom({ uuid: 'p', check_date: 'soon' }), null);
});

test('toCents handles strings and numbers without float drift, and rejects blanks', () => {
  assert.equal(toCents('1234.56'), 123456);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('0.00'), 0);
  assert.equal(toCents('-50.10'), -5010);
  assert.equal(toCents(null), null);
  assert.equal(toCents(''), null);
  assert.equal(toCents('n/a'), null);
});

test('payLineFrom adds hours across jobs and sorts them by pay type', () => {
  const line = payLineFrom({
    gross_pay: '1500.25',
    net_pay: '1100.00',
    hourly_compensations: [
      { name: 'Regular Hours', hours: '30.000', job_uuid: 'a' },
      { name: 'Regular Hours', hours: '10.000', job_uuid: 'b' },
      { name: 'Overtime', hours: '2.500', job_uuid: 'a' },
      { name: 'Double overtime', hours: '1.000', job_uuid: 'a' },
    ],
    paid_time_off: [{ name: 'Vacation Hours', hours: '8.000' }, { name: 'Sick Hours', hours: '0.000' }],
  });
  assert.deepEqual(line, { grossCents: 150025, regularHours: 40, overtimeHours: 3.5, timeOffHours: 8 });
});

test('payLineFrom keeps nothing but gross pay and hours', () => {
  const line = payLineFrom({ gross_pay: '10', net_pay: '8', taxes: [{ amount: '2' }], deductions: [{ amount: 1 }], payment_method: 'Check' });
  assert.deepEqual(Object.keys(line).sort(), ['grossCents', 'overtimeHours', 'regularHours', 'timeOffHours']);
});

test('payLineFrom rejects a compensation with no gross pay, and allows missing hours', () => {
  assert.equal(payLineFrom({ gross_pay: null }), null);
  assert.deepEqual(payLineFrom({ gross_pay: '100.00' }), { grossCents: 10000, regularHours: 0, overtimeHours: 0, timeOffHours: 0 });
});

test('compensationName prefers the preferred name and falls back to the id', () => {
  assert.equal(compensationName({ first_name: 'Nicole', preferred_first_name: 'Nikki', last_name: 'Reed' }), 'Nikki Reed');
  assert.equal(compensationName({ employee_uuid: 'e1' }), 'e1');
});

const row = (payroll, name, gross, extra = {}) => ({
  payroll_uuid: payroll,
  check_date: '2026-10-30',
  period_start: '2026-10-11',
  period_end: '2026-10-24',
  kind: 'regular',
  reversed: 0,
  gross_cents: gross,
  regular_hours: 40,
  overtime_hours: 2,
  time_off_hours: 8,
  display_name: name,
  ...extra,
});

test('groupPayRuns groups by payroll in order and totals gross and worked hours', () => {
  const { runs, grossCents, workedHours, uncounted } = groupPayRuns([row('b', 'Ann', 1000), row('b', 'Bo', 2000), row('a', 'Ann', 500)]);
  assert.deepEqual(runs.map((run) => run.payrollUuid), ['b', 'a']);
  assert.equal(runs[0].people.length, 2);
  assert.equal(runs[0].grossCents, 3000);
  assert.equal(grossCents, 3500);
  assert.equal(workedHours, 126);
  assert.equal(uncounted, 0);
});

test('groupPayRuns leaves reversed payrolls and reversals out of the totals', () => {
  const result = groupPayRuns([
    row('good', 'Ann', 1000),
    row('reversed', 'Ann', 2000, { reversed: 1 }),
    row('reversal', 'Ann', -2000, { kind: 'reversal' }),
  ]);
  assert.equal(result.grossCents, 1000);
  assert.equal(result.uncounted, 2);
  assert.deepEqual(result.runs.map((run) => run.counted), [true, false, false]);
});

test('groupPayRuns handles no rows', () => {
  assert.deepEqual(groupPayRuns([]), { runs: [], uncounted: 0, grossCents: 0, workedHours: 0 });
});
