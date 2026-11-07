#!/usr/bin/env node
/**
 * Moves data between the staff admin (D1) and Gusto using the official Gusto CLI.
 * Gusto doesn't offer its REST API to customers for their own account, and the
 * CLI can't run inside a Worker, so this runs on an admin's computer.
 *
 *   node scripts/gusto-hours.mjs employees [--remote]
 *   node scripts/gusto-hours.mjs history --from YYYY-MM-DD --to YYYY-MM-DD [--remote]
 *   node scripts/gusto-hours.mjs pay --from YYYY-MM-DD --to YYYY-MM-DD [--remote]
 *   node scripts/gusto-hours.mjs push [--remote] [--payroll <uuid>] [--confirm]
 *   node scripts/gusto-hours.mjs resolve <entry-id> --sent <time-sheet-uuid> | --not-sent [--remote]
 *
 * Without --remote this uses the local D1 database. Without --confirm, push only
 * prints what it would send. Requires `gusto auth login`. Set GUSTO_ENVIRONMENT=sandbox
 * to use a Gusto demo company.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { employeeName, primaryJobUuid } from '../src/lib/gusto/employees.mjs';
import { describeShift, planSend } from '../src/lib/gusto/send.mjs';
import {
  PAYROLL_LIST_LIMIT,
  compensationName,
  payLineFrom,
  payRunFrom,
  readPayrollList,
} from '../src/lib/time-clock/gusto-pay.mjs';
import { normalizeTimeRecord, readTimeRecordList } from '../src/lib/time-clock/gusto-records.mjs';
import {
  STORE_TIME_ZONE,
  addDays,
  isIsoDate,
  localDate,
  minutesToHours,
} from '../src/lib/time-clock/hours.mjs';

const run = promisify(execFile);
const GUSTO_BIN = process.env.GUSTO_BIN || 'gusto';
const DATABASE = 'sunnyandranney-db';
const HISTORY_CHUNK_DAYS = 31;
const MAX_OUTPUT = 64 * 1024 * 1024;
// Exit codes the CLI uses when the API definitely refused a request (usage, auth,
// 4xx, validation, blocked). Anything else may have gone through.
const DEFINITE_FAILURE_EXIT_CODES = new Set([2, 3, 4, 7, 8]);

class Stop extends Error {}

// ─── Arguments ───────────────────────────────────────────────

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
    } else if (['--remote', '--confirm', '--not-sent'].includes(arg)) {
      flags[arg.slice(2)] = true;
    } else {
      flags[arg.slice(2)] = rest[++i];
    }
  }
  return { command, flags, positional };
}

// ─── Gusto CLI ───────────────────────────────────────────────

/** Runs the CLI in JSON mode. Never throws for a non-zero exit. */
async function gusto(args) {
  try {
    const { stdout } = await run(GUSTO_BIN, [...args, '--agent'], { maxBuffer: MAX_OUTPUT });
    return { exitCode: 0, ...JSON.parse(stdout) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Stop('The Gusto CLI is not installed. See https://github.com/Gusto/gusto-cli');
    }
    let envelope = {};
    try {
      envelope = JSON.parse(err.stdout ?? '');
    } catch {
      // Not JSON, so report it as an unknown failure below.
    }
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : -1,
      error: envelope.error ?? { code: 'unknown', message: String(err.stderr || err.message).trim() },
    };
  }
}

function requireOk(result, what) {
  if (result.ok) return result.data;
  throw new Stop(`${what} failed: ${result.error?.message ?? result.error?.code ?? 'unknown error'}`);
}

// ─── D1 ──────────────────────────────────────────────────────

const sqlString = (value) =>
  value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll('\0', '').replaceAll("'", "''")}'`;
const sqlNumber = (value) => (Number.isFinite(value) ? String(value) : 'NULL');

async function wrangler(args, remote) {
  const { stdout } = await run(
    'npx',
    ['wrangler', 'd1', 'execute', DATABASE, remote ? '--remote' : '--local', '--json', '--yes', ...args],
    { maxBuffer: MAX_OUTPUT },
  );
  return JSON.parse(stdout);
}

/** One statement. Remote --file runs return a summary, so reads must use --command. */
async function command(sql, remote) {
  const [first] = await wrangler(['--command', sql], remote);
  return first;
}

/**
 * Wrangler's --json output prints SQL NULL as the text "null", which is truthy.
 * Left alone, unsent shifts look sent and open shifts look closed, so every read
 * passes through here.
 */
const withRealNulls = (row) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === 'null' ? null : value]));

const query = async (sql, remote) => ((await command(sql, remote)).results ?? []).map(withRealNulls);

/**
 * Runs one UPDATE and reports how many rows it changed. Counts RETURNING rows
 * because wrangler's local output has no change count in `meta`.
 */
const write = async (sql, remote) => (await query(`${sql} RETURNING id`, remote)).length;

/** Many statements, too long for a command line. Returns no rows. */
async function bulkWrite(statements, remote) {
  const dir = mkdtempSync(join(tmpdir(), 'gusto-hours-'));
  const file = join(dir, 'statements.sql');
  writeFileSync(file, statements.join('\n'));
  try {
    await wrangler(['--file', file], remote);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── employees ───────────────────────────────────────────────

async function syncEmployees({ remote }) {
  const data = requireOk(await gusto(['employee', 'list', '--status', 'all', '--all']), 'Listing employees');
  const employees = Array.isArray(data) ? data : (data.employees ?? data.items ?? []);
  if (employees.length === 0) throw new Stop('Gusto returned no employees, so nothing was changed.');

  const now = new Date().toISOString();
  const statements = [];
  const needsJob = [];

  for (const employee of employees) {
    const name = employeeName(employee);
    if (!employee.uuid || !name) continue;
    const jobUuid = primaryJobUuid(employee);
    const terminated = employee.terminated === true;
    if (!terminated && !jobUuid) needsJob.push(name);

    // New people start inactive: the Gusto account may hold more than store
    // staff, so a manager chooses who appears on the store tablet. Terminated
    // people always come off the clock. A manager's edits to the name stay.
    statements.push(`INSERT INTO staff (id, display_name, gusto_employee_uuid, gusto_job_uuid, active, created_at, updated_at)
      VALUES (${sqlString(randomUUID())}, ${sqlString(name)}, ${sqlString(employee.uuid)}, ${sqlString(jobUuid)}, 0, ${sqlString(now)}, ${sqlString(now)})
      ON CONFLICT(gusto_employee_uuid) DO UPDATE SET
        gusto_job_uuid = excluded.gusto_job_uuid,
        active = CASE WHEN ${terminated ? 1 : 0} = 1 THEN 0 ELSE staff.active END,
        updated_at = excluded.updated_at;`);
  }

  await bulkWrite(statements, remote);
  console.log(`Synced ${statements.length} employees from Gusto. New people start inactive and not marked as store staff; set both in Staff.`);
  if (needsJob.length > 0) {
    console.log(`No single primary job, so their hours can't be pushed yet: ${needsJob.join(', ')}`);
  }
}

// ─── history ─────────────────────────────────────────────────

async function recordsForRange(startDate, endDate) {
  const data = requireOk(
    await gusto(['timesheet', 'list', '--start-date', startDate, '--end-date', endDate]),
    `Reading Gusto hours for ${startDate} to ${endDate}`,
  );
  const list = readTimeRecordList(data);
  if (!list.recognized) {
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
    throw new Stop(
      `Could not read Gusto's time records for ${startDate} to ${endDate}, so nothing was changed. ` +
        `The response had: ${keys}. Update src/lib/time-clock/gusto-records.mjs to match.`,
    );
  }
  return list;
}

async function importHistory({ from, to, remote }) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) {
    throw new Stop('history needs --from and --to as YYYY-MM-DD, with --to on or after --from.');
  }

  const now = new Date().toISOString();
  let imported = 0;
  let incomplete = 0;

  for (let start = from; start <= to; start = addDays(start, HISTORY_CHUNK_DAYS)) {
    const lastDay = addDays(start, HISTORY_CHUNK_DAYS - 1);
    const end = lastDay < to ? lastDay : to;
    const { source, records } = await recordsForRange(start, end);

    const statements = records.map((record) => {
      const row = normalizeTimeRecord(record, source);
      if (!row.recordId || !row.employeeUuid || !row.startedAt || row.hours === null) incomplete++;
      // Records with no id get a stable id from their content, so importing the
      // same dates twice updates rows instead of duplicating them.
      const recordId = row.recordId ?? `sha256:${createHash('sha256').update(row.rawJson).digest('hex')}`;
      return `INSERT INTO gusto_time_records
          (record_id, source, gusto_employee_uuid, employee_name, started_at, ended_at, started_on, hours, status, raw_json, imported_at)
        VALUES (${sqlString(recordId)}, ${sqlString(row.source)}, ${sqlString(row.employeeUuid)}, ${sqlString(row.employeeName)},
          ${sqlString(row.startedAt)}, ${sqlString(row.endedAt)}, ${sqlString(row.startedOn)}, ${sqlNumber(row.hours)},
          ${sqlString(row.status)}, ${sqlString(row.rawJson)}, ${sqlString(now)})
        ON CONFLICT(record_id) DO UPDATE SET
          source = excluded.source, gusto_employee_uuid = excluded.gusto_employee_uuid,
          employee_name = excluded.employee_name, started_at = excluded.started_at, ended_at = excluded.ended_at,
          started_on = excluded.started_on, hours = excluded.hours, status = excluded.status,
          raw_json = excluded.raw_json, imported_at = excluded.imported_at;`;
    });

    if (statements.length > 0) await bulkWrite(statements, remote);
    imported += statements.length;
    console.log(`${start} to ${end}: ${statements.length} records (${source})`);
  }

  console.log(`Imported ${imported} records into Gusto history.`);
  if (incomplete > 0) {
    console.log(
      `${incomplete} records were missing an id, an employee, a start time, or hours. Their raw data is saved in raw_json, ` +
        'so check the field names in src/lib/time-clock/gusto-records.mjs and import again.',
    );
  }
}

// ─── pay ─────────────────────────────────────────────────────

async function payRunsForRange(startDate, endDate) {
  const data = requireOk(
    await gusto([
      'payroll', 'list',
      '--processing-status', 'processed',
      '--payroll-type', 'regular,off_cycle',
      '--date-filter-by', 'check_date',
      '--start-date', startDate,
      '--end-date', endDate,
      '--include', 'reversals',
    ]),
    `Listing payrolls for ${startDate} to ${endDate}`,
  );
  const { payrolls, recognized } = readPayrollList(data);
  if (!recognized) {
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
    throw new Stop(`Could not read Gusto's payroll list for ${startDate} to ${endDate}, so nothing was imported. The response had: ${keys}.`);
  }
  if (payrolls.length >= PAYROLL_LIST_LIMIT) {
    throw new Stop(`Gusto returned ${payrolls.length} payrolls for ${startDate} to ${endDate}, which may be cut off, so nothing was imported.`);
  }
  return payrolls.map((payroll) => {
    const run = payRunFrom(payroll);
    if (!run) throw new Stop(`A payroll from ${startDate} to ${endDate} has no id or check date, so nothing was imported.`);
    return run;
  });
}

/**
 * Reads everything before writing anything, so a stop partway can't leave a page
 * of pay that looks complete but isn't. Only people marked as store staff are
 * saved, and anyone no longer marked is removed.
 */
async function importPay({ from, to, remote }) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) {
    throw new Stop('pay needs --from and --to as YYYY-MM-DD, with --to on or after --from.');
  }

  const storeStaff = await query(
    'SELECT gusto_employee_uuid FROM staff WHERE store_staff = 1 AND gusto_employee_uuid IS NOT NULL',
    remote,
  );
  if (storeStaff.length === 0) {
    throw new Stop('Nobody is marked as store staff, so nothing was imported. Run employees, then mark them in Staff.');
  }
  const wanted = new Set(storeStaff.map((person) => person.gusto_employee_uuid));

  const now = new Date().toISOString();
  const seen = new Set();
  const statements = [];
  const leftOut = new Set();
  let runCount = 0;
  let reversals = 0;

  for (let start = from; start <= to; start = addDays(start, HISTORY_CHUNK_DAYS)) {
    const lastDay = addDays(start, HISTORY_CHUNK_DAYS - 1);
    const end = lastDay < to ? lastDay : to;

    for (const run of await payRunsForRange(start, end)) {
      if (seen.has(run.payrollUuid)) continue;
      seen.add(run.payrollUuid);

      const detail = requireOk(await gusto(['payroll', 'show', run.payrollUuid]), `Reading the payroll paid ${run.checkDate}`);
      if (!Array.isArray(detail?.employee_compensations)) {
        throw new Stop(`The payroll paid ${run.checkDate} has no employee pay in Gusto's response, so nothing was imported.`);
      }

      let storeLines = 0;
      for (const compensation of detail.employee_compensations) {
        if (compensation.excluded) continue;
        if (!wanted.has(compensation.employee_uuid)) {
          leftOut.add(compensationName(compensation));
          continue;
        }
        const line = payLineFrom(compensation);
        if (!line) {
          throw new Stop(`Gusto gave no gross pay for ${compensationName(compensation)} on the payroll paid ${run.checkDate}, so nothing was imported.`);
        }
        storeLines++;
        statements.push(`INSERT INTO gusto_pay_records
            (payroll_uuid, gusto_employee_uuid, check_date, period_start, period_end, kind, reversed,
             gross_cents, regular_hours, overtime_hours, time_off_hours, imported_at)
          VALUES (${sqlString(run.payrollUuid)}, ${sqlString(compensation.employee_uuid)}, ${sqlString(run.checkDate)},
            ${sqlString(run.periodStart)}, ${sqlString(run.periodEnd)}, ${sqlString(run.kind)}, ${run.reversed ? 1 : 0},
            ${sqlNumber(line.grossCents)}, ${sqlNumber(line.regularHours)}, ${sqlNumber(line.overtimeHours)},
            ${sqlNumber(line.timeOffHours)}, ${sqlString(now)})
          ON CONFLICT(payroll_uuid, gusto_employee_uuid) DO UPDATE SET
            check_date = excluded.check_date, period_start = excluded.period_start, period_end = excluded.period_end,
            kind = excluded.kind, reversed = excluded.reversed, gross_cents = excluded.gross_cents,
            regular_hours = excluded.regular_hours, overtime_hours = excluded.overtime_hours,
            time_off_hours = excluded.time_off_hours, imported_at = excluded.imported_at;`);
      }
      if (storeLines > 0) {
        runCount++;
        if (run.reversed || run.kind === 'reversal') reversals++;
      }
    }
    console.log(`${start} to ${end}: read`);
  }

  statements.push(`DELETE FROM gusto_pay_records WHERE gusto_employee_uuid NOT IN
    (SELECT gusto_employee_uuid FROM staff WHERE store_staff = 1 AND gusto_employee_uuid IS NOT NULL);`);
  await bulkWrite(statements, remote);

  console.log(`Imported ${statements.length - 1} pay lines from ${runCount} payrolls for store staff.`);
  if (leftOut.size > 0) {
    console.log(`Not marked as store staff, so left out: ${[...leftOut].sort().join(', ')}`);
  }
  if (reversals > 0) {
    console.log(`${reversals} payrolls involve a reversal. They are flagged on the Payroll page and left out of its totals.`);
  }
}

// ─── push ────────────────────────────────────────────────────

async function findDraftPayroll(payrollUuid) {
  const data = requireOk(await gusto(['payroll', 'list', '--processing-status', 'unprocessed']), 'Listing draft payrolls');
  const payrolls = Array.isArray(data) ? data : (data.payrolls ?? data.items ?? []);
  if (payrollUuid) {
    const match = payrolls.find((payroll) => payroll.payroll_uuid === payrollUuid || payroll.uuid === payrollUuid);
    if (!match) throw new Stop(`No draft payroll has the id ${payrollUuid}.`);
    return match;
  }
  if (payrolls.length !== 1) {
    const list = payrolls
      .map((p) => `  ${p.payroll_uuid ?? p.uuid}  ${p.pay_period?.start_date} to ${p.pay_period?.end_date}`)
      .join('\n');
    throw new Stop(`Found ${payrolls.length} draft payrolls. Choose one with --payroll <uuid>:\n${list}`);
  }
  return payrolls[0];
}

/**
 * Gusto clock-ins and pushed time sheets would both count toward payroll, so a
 * period holding any record that isn't ours risks paying the same hours twice.
 * An unreadable response stops the push too, inside recordsForRange.
 */
async function assertNoGustoClockIns(start, end) {
  const { source, records } = await recordsForRange(start, end);
  if (records.length > 0 && source !== 'third_party') {
    throw new Stop(
      `Gusto already has ${records.length} ${source} time records from ${start} to ${end}. Pushing could pay those ` +
        'hours twice. Nothing was sent. Turn off Gusto time tracking and clear those hours from this period first.',
    );
  }
}

async function pushHours({ remote, confirm, payroll: payrollUuid }) {
  const interrupted = await query(
    `SELECT e.id, e.clock_in_at, s.display_name FROM time_entries e JOIN staff s ON s.id = e.staff_id WHERE e.push_state = 'pushing'`,
    remote,
  );
  if (interrupted.length > 0) {
    const lines = interrupted.map((entry) => `  ${entry.id}  ${describeShift(entry)}`).join('\n');
    throw new Stop(
      `An earlier push stopped partway through these shifts:\n${lines}\n` +
        'They may or may not be in Gusto. Check Gusto, then run `resolve <entry-id> --sent <time-sheet-uuid>` or ' +
        '`resolve <entry-id> --not-sent` for each one.',
    );
  }

  const payroll = await findDraftPayroll(payrollUuid);
  const start = payroll.pay_period?.start_date;
  const end = payroll.pay_period?.end_date;
  const payScheduleUuid = payroll.pay_period?.pay_schedule_uuid ?? payroll.pay_schedule_uuid;
  if (!isIsoDate(start) || !isIsoDate(end) || !payScheduleUuid) {
    throw new Stop('Could not read the pay period from the draft payroll. Nothing was sent.');
  }

  // Reach back a week so overtime counts hours from a workweek that began in
  // the previous pay period.
  const entries = await query(
    `SELECT e.*, s.display_name, s.overtime_eligible, s.gusto_employee_uuid, s.gusto_job_uuid
     FROM time_entries e JOIN staff s ON s.id = e.staff_id
     WHERE e.status <> 'rejected'
       AND e.clock_in_at >= ${sqlString(`${addDays(start, -8)}T00:00:00.000Z`)}
       AND e.clock_in_at < ${sqlString(`${addDays(end, 2)}T00:00:00.000Z`)}
     ORDER BY e.clock_in_at`,
    remote,
  );

  const { blockers, toSend } = planSend(entries, start, end);
  if (blockers.length > 0) {
    throw new Stop(`This pay period isn't ready, so nothing was sent:\n  ${blockers.join('\n  ')}`);
  }

  if (toSend.length === 0) {
    console.log(`Pay period ${start} to ${end}. Nothing new to send.`);
    return;
  }

  console.log(`Pay period ${start} to ${end}. ${toSend.length} shifts to send.`);
  for (const entry of toSend) {
    const { regularMinutes, overtimeMinutes } = entry;
    console.log(
      `  ${describeShift(entry).padEnd(32)} regular ${minutesToHours(regularMinutes)}  overtime ${minutesToHours(overtimeMinutes)}`,
    );
  }

  await assertNoGustoClockIns(start, end);

  if (!confirm) {
    console.log('Dry run: nothing was sent. Add --confirm to send these to Gusto.');
    return;
  }

  for (const entry of toSend) {
    const { regularMinutes, overtimeMinutes } = entry;

    // Marked first, so a crash can't leave a sent shift looking unsent. The
    // version check also catches Staci reopening the shift during this run.
    const claimed = await write(
      `UPDATE time_entries SET push_state = 'pushing'
       WHERE id = ${sqlString(entry.id)} AND version = ${sqlNumber(entry.version)}
         AND status = 'approved' AND push_state IS NULL`,
      remote,
    );
    if (claimed !== 1) throw new Stop(`${describeShift(entry)} changed during this push. Stopped; run push again.`);

    const args = [
      'timesheet', 'create',
      '--employee-uuid', entry.gusto_employee_uuid,
      '--job-uuid', entry.gusto_job_uuid,
      '--start', entry.clock_in_at,
      '--end', entry.clock_out_at,
      '--time-zone', STORE_TIME_ZONE,
      '--confirm',
    ];
    if (regularMinutes > 0) args.push('--regular', minutesToHours(regularMinutes));
    if (overtimeMinutes > 0) args.push('--overtime', minutesToHours(overtimeMinutes));

    const result = await gusto(args);

    if (result.ok) {
      const uuid = result.data?.uuid ?? result.data?.time_sheet?.uuid ?? null;
      const now = new Date().toISOString();
      await write(
        `UPDATE time_entries SET push_state = 'pushed', gusto_time_sheet_uuid = ${sqlString(uuid)}, pushed_at = ${sqlString(now)},
           version = version + 1, updated_at = ${sqlString(now)} WHERE id = ${sqlString(entry.id)}`,
        remote,
      );
      await command(
        `INSERT INTO time_entry_events (entry_id, action, actor, detail, created_at)
         VALUES (${sqlString(entry.id)}, 'push', 'gusto-hours script', ${sqlString(JSON.stringify({ time_sheet_uuid: uuid }))}, ${sqlString(now)})`,
        remote,
      );
      console.log(`Sent ${describeShift(entry)}.`);
    } else if (DEFINITE_FAILURE_EXIT_CODES.has(result.exitCode)) {
      await write(`UPDATE time_entries SET push_state = NULL WHERE id = ${sqlString(entry.id)}`, remote);
      throw new Stop(`Gusto refused ${describeShift(entry)}: ${result.error?.message}. Fix that, then run push again.`);
    } else {
      // A timeout or server error may still have created the time sheet, so the
      // 'pushing' mark stays and the next run asks a person to check.
      throw new Stop(`No clear answer from Gusto for ${describeShift(entry)}: ${result.error?.message}. Check Gusto, then use resolve.`);
    }
  }

  const syncArgs = [
    'timesheet', 'sync',
    '--pay-schedule-uuid', payScheduleUuid,
    '--start-date', start,
    '--end-date', end,
    '--confirm',
  ];
  const sync = await gusto(syncArgs);
  if (!sync.ok) {
    throw new Stop(`The hours were sent, but the payroll sync failed: ${sync.error?.message}\nTo retry it: gusto ${syncArgs.join(' ')}`);
  }
  console.log('Sync started. It runs in the background, so check the hours on the draft payroll in Gusto before running it.');
}

// ─── resolve ─────────────────────────────────────────────────

async function resolveEntry({ entryId, sent, notSent, remote }) {
  if (!entryId || Boolean(sent) === Boolean(notSent)) {
    throw new Stop('Use: resolve <entry-id> --sent <time-sheet-uuid>, or resolve <entry-id> --not-sent');
  }
  const now = new Date().toISOString();
  const update = sent
    ? `push_state = 'pushed', gusto_time_sheet_uuid = ${sqlString(sent)}, pushed_at = ${sqlString(now)}, version = version + 1, updated_at = ${sqlString(now)}`
    : 'push_state = NULL';
  const changed = await write(
    `UPDATE time_entries SET ${update} WHERE id = ${sqlString(entryId)} AND push_state = 'pushing'`,
    remote,
  );
  if (changed !== 1) throw new Stop('That shift is not waiting to be resolved.');
  await command(
    `INSERT INTO time_entry_events (entry_id, action, actor, detail, created_at)
     VALUES (${sqlString(entryId)}, 'push_resolved', 'gusto-hours script', ${sqlString(JSON.stringify({ sent: sent ?? null }))}, ${sqlString(now)})`,
    remote,
  );
  console.log(sent ? 'Marked as sent.' : 'Cleared. The next push will send it.');
}

// ─── Entry point ─────────────────────────────────────────────

async function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  const remote = Boolean(flags.remote);

  switch (command) {
    case 'employees':
      return syncEmployees({ remote });
    case 'history':
      return importHistory({ from: flags.from, to: flags.to, remote });
    case 'pay':
      return importPay({ from: flags.from, to: flags.to, remote });
    case 'push':
      return pushHours({ remote, confirm: Boolean(flags.confirm), payroll: flags.payroll });
    case 'resolve':
      return resolveEntry({ entryId: positional[0], sent: flags.sent, notSent: flags['not-sent'], remote });
    default:
      throw new Stop('Commands: employees, history, pay, push, resolve. See the top of this file for usage.');
  }
}

main().catch((err) => {
  console.error(err instanceof Stop ? err.message : err);
  process.exit(1);
});
