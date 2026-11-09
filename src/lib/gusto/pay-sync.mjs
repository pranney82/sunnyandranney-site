/**
 * Brings gusto_pay_records up to date with Gusto when a page opens. The payroll
 * list is read fresh every time, and only payrolls not seen before are read in
 * full, which keeps a page load within a Worker's limit on outbound requests.
 */
import { addDays } from '../time-clock/hours.mjs';
import { compensationName, payLineFrom, payRunFrom } from '../time-clock/gusto-pay.mjs';
import { GustoError } from './oauth.mjs';

const MAX_READS_PER_LOAD = 30;
// Gusto rejects a range over about a year, or an end date more than 3 months out.
const LIST_WINDOW_DAYS = 360;
const FUTURE_LIMIT_DAYS = 60;
// Gusto's check-date filter only covers regular payrolls, so an off-cycle one is
// matched on its pay period. Reading a wider range, then filtering, catches those.
const OFF_CYCLE_MARGIN_DAYS = 31;

async function listRuns(client, from, to, today) {
  const furthest = addDays(today, FUTURE_LIMIT_DAYS);
  const wantedEnd = addDays(to, OFF_CYCLE_MARGIN_DAYS);
  const lastDay = wantedEnd < furthest ? wantedEnd : furthest;
  const runs = new Map();

  for (let start = addDays(from, -OFF_CYCLE_MARGIN_DAYS); start <= lastDay; start = addDays(start, LIST_WINDOW_DAYS)) {
    const windowEnd = addDays(start, LIST_WINDOW_DAYS - 1);
    const payrolls = await client.listPayrolls({
      processing_statuses: 'processed',
      payroll_types: 'regular,off_cycle',
      date_filter_by: 'check_date',
      start_date: start,
      end_date: windowEnd < lastDay ? windowEnd : lastDay,
      include: 'reversals',
      sort_order: 'desc',
    });
    for (const payroll of payrolls) {
      const run = payRunFrom(payroll);
      if (!run) throw new GustoError('Gusto sent a payroll with no id or check date.');
      runs.set(run.payrollUuid, run);
    }
  }
  return [...runs.values()].filter((run) => run.checkDate >= from && run.checkDate <= to);
}

function payStatements(db, run, compensations, wanted, now) {
  const statements = [];
  for (const compensation of compensations) {
    if (compensation.excluded || !wanted.has(compensation.employee_uuid)) continue;
    const line = payLineFrom(compensation);
    if (!line) throw new GustoError(`Gusto gave no gross pay for ${compensationName(compensation)} on the payroll paid ${run.checkDate}.`);
    statements.push(
      db
        .prepare(
          `INSERT INTO gusto_pay_records
             (payroll_uuid, gusto_employee_uuid, check_date, period_start, period_end, kind, reversed,
              gross_cents, regular_hours, overtime_hours, time_off_hours, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(payroll_uuid, gusto_employee_uuid) DO UPDATE SET
             check_date = excluded.check_date, period_start = excluded.period_start, period_end = excluded.period_end,
             kind = excluded.kind, reversed = excluded.reversed, gross_cents = excluded.gross_cents,
             regular_hours = excluded.regular_hours, overtime_hours = excluded.overtime_hours,
             time_off_hours = excluded.time_off_hours, imported_at = excluded.imported_at`,
        )
        .bind(
          run.payrollUuid, compensation.employee_uuid, run.checkDate, run.periodStart, run.periodEnd, run.kind,
          run.reversed ? 1 : 0, line.grossCents, line.regularHours, line.overtimeHours, line.timeOffHours, now,
        ),
    );
  }
  return statements;
}

/** @returns how many payrolls this read, and how many in the range are still unread */
export async function refreshPay(db, client, { from, to, today }) {
  const { results: staff } = await db
    .prepare('SELECT gusto_employee_uuid FROM staff WHERE store_staff = 1 AND gusto_employee_uuid IS NOT NULL')
    .all();
  if (staff.length === 0) return { remaining: 0, read: 0 };
  const wanted = new Set(staff.map((person) => person.gusto_employee_uuid));

  const runs = await listRuns(client, from, to, today);
  const { results: seen } = await db
    .prepare('SELECT payroll_uuid FROM gusto_pay_read WHERE check_date >= ? AND check_date <= ?')
    .bind(from, to)
    .all();
  const alreadyRead = new Set(seen.map((row) => row.payroll_uuid));
  const unread = runs.filter((run) => !alreadyRead.has(run.payrollUuid));

  const now = new Date().toISOString();
  for (const run of unread.slice(0, MAX_READS_PER_LOAD)) {
    const detail = await client.getPayroll(run.payrollUuid);
    if (!Array.isArray(detail?.employee_compensations)) {
      throw new GustoError(`The payroll paid ${run.checkDate} came back with no employee pay.`);
    }
    await db.batch([
      ...payStatements(db, run, detail.employee_compensations, wanted, now),
      db
        .prepare('INSERT OR REPLACE INTO gusto_pay_read (payroll_uuid, check_date, read_at) VALUES (?, ?, ?)')
        .bind(run.payrollUuid, run.checkDate, now),
    ]);
  }

  const upkeep = runs
    .filter((run) => run.reversed)
    .map((run) => db.prepare('UPDATE gusto_pay_records SET reversed = 1 WHERE payroll_uuid = ? AND reversed = 0').bind(run.payrollUuid));
  // A payroll Gusto no longer lists was cancelled. An empty list is more likely a
  // problem than a company with no payroll, so it never clears anything.
  if (runs.length > 0) {
    const listed = JSON.stringify(runs.map((run) => run.payrollUuid));
    for (const table of ['gusto_pay_records', 'gusto_pay_read']) {
      upkeep.push(
        db
          .prepare(`DELETE FROM ${table} WHERE check_date >= ? AND check_date <= ? AND payroll_uuid NOT IN (SELECT value FROM json_each(?))`)
          .bind(from, to, listed),
      );
    }
  }
  if (upkeep.length > 0) await db.batch(upkeep);

  return {
    read: Math.min(unread.length, MAX_READS_PER_LOAD),
    remaining: Math.max(0, unread.length - MAX_READS_PER_LOAD),
  };
}
