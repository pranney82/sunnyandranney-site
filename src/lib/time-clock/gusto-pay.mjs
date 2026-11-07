/**
 * Turns `gusto payroll list` and `gusto payroll show` output into rows for
 * gusto_pay_records, and groups those rows for the Payroll page.
 *
 * Managers read these rows, so only gross pay and hours are kept. Net pay,
 * taxes, deductions, benefits and payment details stay in Gusto.
 */
import { isIsoDate } from './hours.mjs';

/**
 * The CLI reads one page of `payroll list`, and Gusto's default page holds 25.
 * A result this long may have been cut off, so the import stops instead of
 * under-reporting pay.
 */
export const PAYROLL_LIST_LIMIT = 25;

const OVERTIME = /overtime/i;
const REVERSAL = /reversal/i;

const asList = (value) => (Array.isArray(value) ? value : []);
const roundHours = (hours) => Math.round(hours * 1000) / 1000;
const sumHours = (items) => items.reduce((sum, item) => sum + (Number(item.hours) || 0), 0);

/** `recognized` is false for a response this code can't read, which must not be taken as "no payrolls". */
export function readPayrollList(data) {
  const list = Array.isArray(data) ? data : (data?.payrolls ?? data?.items);
  return { payrolls: asList(list), recognized: Array.isArray(list) };
}

/**
 * Gusto records a reversal as its own off-cycle payroll, and lists its id on the
 * payroll it reversed. The docs don't say whether a reversal's gross is negative,
 * so both are flagged and left out of totals rather than guessed at.
 *
 * @returns the payroll's details, or null if it has no id or check date
 */
export function payRunFrom(payroll) {
  const payrollUuid = payroll?.payroll_uuid ?? payroll?.uuid;
  if (!payrollUuid || !isIsoDate(payroll.check_date)) return null;
  const isReversal = REVERSAL.test(payroll.off_cycle_reason ?? '');
  return {
    payrollUuid,
    checkDate: payroll.check_date,
    periodStart: payroll.pay_period?.start_date ?? null,
    periodEnd: payroll.pay_period?.end_date ?? null,
    kind: isReversal ? 'reversal' : payroll.off_cycle ? 'off_cycle' : 'regular',
    reversed: asList(payroll.reversal_payroll_uuids).length > 0,
  };
}

export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** @returns hours and gross pay for one employee, or null if Gusto gave no usable gross pay */
export function payLineFrom(compensation) {
  const grossCents = toCents(compensation.gross_pay);
  if (grossCents === null) return null;
  const hourly = asList(compensation.hourly_compensations);
  return {
    grossCents,
    regularHours: roundHours(sumHours(hourly.filter((item) => !OVERTIME.test(item.name ?? '')))),
    overtimeHours: roundHours(sumHours(hourly.filter((item) => OVERTIME.test(item.name ?? '')))),
    timeOffHours: roundHours(sumHours(asList(compensation.paid_time_off))),
  };
}

export function compensationName(compensation) {
  const first = compensation.preferred_first_name || compensation.first_name || '';
  return [first, compensation.last_name].filter(Boolean).join(' ').trim() || compensation.employee_uuid || 'Unknown';
}

/**
 * Groups gusto_pay_records rows by payroll, keeping their order. Totals cover
 * worked hours and gross pay, and skip any payroll touched by a reversal.
 */
export function groupPayRuns(rows) {
  const byPayroll = new Map();
  for (const row of rows) {
    let run = byPayroll.get(row.payroll_uuid);
    if (!run) {
      run = {
        payrollUuid: row.payroll_uuid,
        checkDate: row.check_date,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        kind: row.kind,
        reversed: Boolean(row.reversed),
        counted: row.kind !== 'reversal' && !row.reversed,
        people: [],
        grossCents: 0,
        regularHours: 0,
        overtimeHours: 0,
        timeOffHours: 0,
      };
      byPayroll.set(row.payroll_uuid, run);
    }
    run.people.push(row);
    run.grossCents += row.gross_cents;
    run.regularHours += row.regular_hours;
    run.overtimeHours += row.overtime_hours;
    run.timeOffHours += row.time_off_hours;
  }

  const runs = [...byPayroll.values()];
  const counted = runs.filter((run) => run.counted);
  return {
    runs,
    uncounted: runs.length - counted.length,
    grossCents: counted.reduce((sum, run) => sum + run.grossCents, 0),
    workedHours: counted.reduce((sum, run) => sum + run.regularHours + run.overtimeHours, 0),
  };
}
