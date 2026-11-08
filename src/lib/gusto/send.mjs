/**
 * Sends approved shifts to Gusto. Through the partner API they become time
 * sheets that are then pulled into the draft payroll. Through Gusto's MCP
 * server they go into Gusto's own time tracking, which payroll reads from.
 * Nothing here can submit a payroll: that stays in Gusto. Each shift is marked
 * before it's sent and tagged with its id, so a shift that fails halfway can be
 * matched against Gusto rather than guessed at, and is never paid twice.
 */
import { STORE_TIME_ZONE, addDays, classifyEntries, isIsoDate, localDate, minutesToHours, withOffset } from '../time-clock/hours.mjs';
import { GustoError } from './oauth.mjs';

export const SEND_BATCH_SIZE = 15;
const SOURCE = 'sunny-and-ranney-admin';
// record_time has no metadata field, so the shift id travels in the note.
export const NOTE_PREFIX = 'Sunny & Ranney admin shift ';
// Gusto may take a moment to list a time sheet it just accepted.
const RECONCILE_AFTER_MS = 2 * 60 * 1000;

export function describeShift(entry) {
  return `${entry.display_name}, ${localDate(entry.clock_in_at)}`;
}

/**
 * Works out what a pay period needs. `entries` must reach back a week before the
 * period, so overtime counts hours from a workweek that began in the last one.
 */
export function planSend(entries, start, end, { needsGustoLink = true } = {}) {
  const inPeriod = entries.filter((entry) => {
    const day = localDate(entry.clock_in_at);
    return day >= start && day <= end;
  });

  const blockers = [];
  for (const entry of inPeriod) {
    if (!entry.clock_out_at) blockers.push(`${describeShift(entry)}: no clock-out`);
    else if (entry.status !== 'approved') blockers.push(`${describeShift(entry)}: not approved`);
    else if (needsGustoLink && !entry.push_state && (!entry.gusto_employee_uuid || !entry.gusto_job_uuid)) {
      blockers.push(`${describeShift(entry)}: not linked to a Gusto employee and job`);
    }
  }

  const split = classifyEntries(entries);
  const toSend = inPeriod
    .filter((entry) => !entry.push_state)
    .map((entry) => ({ ...entry, ...split.get(entry.id) }))
    .filter((entry) => blockers.length > 0 || entry.regularMinutes + entry.overtimeMinutes > 0);

  return {
    blockers,
    toSend,
    interrupted: inPeriod.filter((entry) => entry.push_state === 'pushing'),
    alreadySent: inPeriod.filter((entry) => entry.push_state === 'pushed').length,
  };
}

export function timeSheetBody(entry) {
  const entries = [];
  if (entry.regularMinutes > 0) entries.push({ hours_worked: minutesToHours(entry.regularMinutes), pay_classification: 'Regular' });
  if (entry.overtimeMinutes > 0) entries.push({ hours_worked: minutesToHours(entry.overtimeMinutes), pay_classification: 'Overtime' });
  return {
    entity_uuid: entry.gusto_employee_uuid,
    entity_type: 'Employee',
    job_uuid: entry.gusto_job_uuid,
    time_zone: STORE_TIME_ZONE,
    shift_started_at: entry.clock_in_at,
    shift_ended_at: entry.clock_out_at,
    entries,
    metadata: { source: SOURCE, entry_id: entry.id },
  };
}

/**
 * What record_time needs for one shift. Gusto works out overtime itself and
 * refuses a time without its offset. The note only survives in Gusto's own
 * time tracking; a third-party tracker drops it with a warning, so it's left off.
 */
export function recordTimeArgs(entry, memberUuid, { withNote = false } = {}) {
  return {
    company_member_uuid: memberUuid,
    job_uuid: entry.gusto_job_uuid,
    shift_started_at: withOffset(entry.clock_in_at),
    shift_ended_at: withOffset(entry.clock_out_at),
    timezone: STORE_TIME_ZONE,
    on_existing: 'add',
    ...(withNote ? { note: `${NOTE_PREFIX}${entry.id}` } : {}),
  };
}

/** Same person, same start minute: how a sent shift is recognized, since Gusto never returns notes. */
export const shiftKey = (employeeUuid, startedAt) =>
  employeeUuid && startedAt ? `${employeeUuid}|${new Date(startedAt).toISOString().slice(0, 16)}` : null;

/**
 * Reads list_time_records. Gusto names its shape in `source`: its own time
 * tracking (`shifts`, plus `workers`), a third-party tracker (`timesheets`), or
 * `none`. Anything else stops the send rather than passing for an empty period.
 *
 * @returns the records in one shape, and each employee's company member id,
 *   which is the only way record_time knows who worked
 */
export function timeRecordsFrom(answer) {
  const source = answer?.source;
  const list = source === 'native' ? answer.shifts : source === 'third_party' ? answer.timesheets : source === 'none' ? [] : null;
  if (!Array.isArray(list)) throw new GustoError('Gusto sent an unreadable list of hours.');

  const members = new Map();
  const workers = source === 'native' && Array.isArray(answer.workers) ? answer.workers : [];
  for (const worker of [...workers, ...list]) {
    if (worker?.employeeUuid && worker?.companyMemberUuid) members.set(worker.employeeUuid, worker.companyMemberUuid);
  }

  const records = list.map((record) => {
    const startedAt = record?.shiftStartedAt ?? record?.clockInTimestamp ?? null;
    return {
      id: record?.id ?? null,
      entryId: null,
      ours: false,
      rejected: /reject/i.test(String(record?.status ?? '')),
      startedAt,
      // A contractor's clock times can come back empty, but the date never does.
      day: record?.date ?? (startedAt ? localDate(startedAt) : null),
      employeeUuid: record?.employeeUuid ?? null,
    };
  });
  return { source, records, members };
}

/** The Gusto calls a send needs, for whichever way the site is connected. */
function timeSheetsFor(client) {
  if (client.route === 'mcp') {
    return {
      async list(start, end) {
        return timeRecordsFrom(await client.listTimeRecords({ start: addDays(start, -8), end: addDays(end, 1) }));
      },
      async create(entry, gusto) {
        const memberUuid = gusto.members.get(entry.gusto_employee_uuid);
        const result = await client.recordTime(recordTimeArgs(entry, memberUuid, { withNote: gusto.source === 'native' }));
        return { id: result?.id ?? null, warning: typeof result?.warning === 'string' ? result.warning : null };
      },
      // Gusto's payroll reads time tracking itself, so there is nothing to sync.
      sync: null,
    };
  }
  return {
    async list(start) {
      const sheets = await client.getPaged(client.companyPath('time_tracking/time_sheets'), { after: `${addDays(start, -8)}T00:00:00Z`, per: 100 });
      const records = sheets.map((sheet) => ({
        id: sheet.uuid,
        entryId: sheet.metadata?.entry_id ?? null,
        ours: sheet.metadata?.source === SOURCE,
        rejected: sheet.status === 'rejected',
        startedAt: sheet.shift_started_at ?? null,
        day: sheet.shift_started_at ? localDate(sheet.shift_started_at) : null,
        employeeUuid: sheet.entity_uuid ?? null,
      }));
      return { source: 'api', records, members: null };
    },
    async create(entry) {
      const sheet = await client.post(client.companyPath('time_tracking/time_sheets'), timeSheetBody(entry));
      return { id: sheet?.uuid ?? null, warning: null };
    },
    async sync(payroll) {
      await client.post(client.companyPath('time_tracking/payroll_syncs'), {
        kind: 'regular',
        pay_schedule_uuid: payroll.payScheduleUuid,
        pay_period_start_date: payroll.start,
        pay_period_end_date: payroll.end,
      });
    },
  };
}

/** Gusto's draft payrolls, oldest first. */
export async function draftPayrolls(client, today) {
  const rows = await client.listPayrolls({
    processing_statuses: 'unprocessed',
    payroll_types: 'regular',
    start_date: addDays(today, -60),
    end_date: addDays(today, 60),
    sort_order: 'asc',
  });
  return rows
    .map((payroll) => ({
      uuid: payroll.payroll_uuid ?? payroll.uuid,
      start: payroll.pay_period?.start_date,
      end: payroll.pay_period?.end_date,
      payScheduleUuid: payroll.pay_period?.pay_schedule_uuid ?? payroll.pay_schedule_uuid,
      checkDate: payroll.check_date ?? null,
      // When Gusto needs the payroll submitted, if it says.
      deadline: payroll.payroll_deadline ?? null,
    }))
    // Only the partner API's payroll sync needs the pay schedule.
    .filter((payroll) => payroll.uuid && isIsoDate(payroll.start) && isIsoDate(payroll.end) && (client.route === 'mcp' || payroll.payScheduleUuid));
}

/**
 * The draft payroll to work on now: the latest period that has ended (its hours
 * are due), or else the one running today, or else the next one.
 */
export function payrollToWorkOn(drafts, today) {
  return (
    [...drafts].reverse().find((payroll) => payroll.end < today) ??
    drafts.find((payroll) => payroll.start <= today && payroll.end >= today) ??
    drafts[0] ??
    null
  );
}

async function loadEntries(db, start, end) {
  const { results } = await db
    .prepare(
      `SELECT e.*, s.display_name, s.overtime_eligible, s.gusto_employee_uuid, s.gusto_job_uuid
       FROM time_entries e JOIN staff s ON s.id = e.staff_id
       WHERE e.status <> 'rejected' AND e.clock_in_at >= ? AND e.clock_in_at < ?
       ORDER BY e.clock_in_at`,
    )
    .bind(`${addDays(start, -8)}T00:00:00.000Z`, `${addDays(end, 2)}T00:00:00.000Z`)
    .all();
  return results;
}

function recordPushed(db, entry, uuid, actor) {
  const now = new Date().toISOString();
  return db.batch([
    db
      .prepare(
        `UPDATE time_entries SET push_state = 'pushed', gusto_time_sheet_uuid = ?, pushed_at = ?, version = version + 1,
           updated_at = ? WHERE id = ?`,
      )
      .bind(uuid, now, now, entry.id),
    db
      .prepare(`INSERT INTO time_entry_events (entry_id, action, actor, detail, created_at) VALUES (?, 'push', ?, ?, ?)`)
      .bind(entry.id, actor, JSON.stringify({ time_sheet_uuid: uuid }), now),
  ]);
}

/**
 * Settles shifts an earlier send left marked. Found in Gusto means it arrived.
 * Not found clears the mark, but only once Gusto has had time to list it.
 * @returns the shifts still undecided
 */
async function reconcile(db, client, interrupted, start, end, actor) {
  if (interrupted.length === 0) return [];
  const { records } = await timeSheetsFor(client).list(start, end);
  const byEntry = new Map(records.filter((record) => record.entryId).map((record) => [record.entryId, record.id]));
  const byShift = new Map(records.map((record) => [shiftKey(record.employeeUuid, record.startedAt), record.id]).filter(([key]) => key));

  const undecided = [];
  for (const entry of interrupted) {
    const key = shiftKey(entry.gusto_employee_uuid, entry.clock_in_at);
    if (byEntry.has(entry.id) || byShift.has(key)) {
      await recordPushed(db, entry, byEntry.get(entry.id) ?? byShift.get(key) ?? null, actor);
    } else if (Date.now() - Date.parse(entry.updated_at) > RECONCILE_AFTER_MS) {
      await db.prepare(`UPDATE time_entries SET push_state = NULL WHERE id = ? AND push_state = 'pushing'`).bind(entry.id).run();
    } else {
      undecided.push(entry);
    }
  }
  return undecided;
}

/**
 * Hours in Gusto that this admin didn't send would also count toward payroll,
 * so a person with any in the period could be paid twice. Only the people being
 * sent matter: others in the Gusto account may clock in there legitimately. The
 * partner API only shows other apps' time sheets; the MCP server also shows
 * Gusto's own clock-ins. A record that doesn't say whose it is counts.
 */
export function foreignRecords(records, plan, start, end) {
  const known = new Set(plan.alreadyKnown);
  const sentShifts = new Set(plan.sentShiftKeys);
  const people = new Set(plan.toSend.map((entry) => entry.gusto_employee_uuid).filter(Boolean));
  return records.filter((record) => {
    if (record.ours || record.rejected || known.has(record.id) || sentShifts.has(shiftKey(record.employeeUuid, record.startedAt))) return false;
    if (record.employeeUuid && !people.has(record.employeeUuid)) return false;
    return record.day !== null && record.day >= start && record.day <= end;
  });
}

/**
 * Each person's approved hours for a pay period, split into regular and
 * overtime the same way Staci saw them. Overtime counts the workweek that
 * began before the period, so `entries` must reach back a week.
 */
export function periodTotals(entries, start, end) {
  const split = classifyEntries(entries);
  const people = new Map();
  for (const entry of entries) {
    const day = localDate(entry.clock_in_at);
    if (day < start || day > end || entry.status !== 'approved' || !entry.clock_out_at || !entry.gusto_employee_uuid) continue;
    const { regularMinutes, overtimeMinutes } = split.get(entry.id);
    const person = people.get(entry.gusto_employee_uuid) ?? {
      name: entry.display_name,
      employeeUuid: entry.gusto_employee_uuid,
      jobUuid: entry.gusto_job_uuid,
      regularMinutes: 0,
      overtimeMinutes: 0,
    };
    person.regularMinutes += regularMinutes;
    person.overtimeMinutes += overtimeMinutes;
    people.set(entry.gusto_employee_uuid, person);
  }
  return [...people.values()];
}

// Gusto only takes hours for people paid by the hour.
const HOURLY_FLSA = new Set(['Nonexempt', 'Salaried Nonexempt', 'Commission Only Nonexempt']);

function hourLine(lines, pattern, jobUuid) {
  const named = lines.filter((line) => pattern.test(line.name ?? ''));
  return named.find((line) => line.job_uuid === jobUuid) ?? (named.length === 1 ? named[0] : null);
}

/**
 * What to set on the draft payroll for each person, matched to Gusto's own hour
 * lines. Anyone who can't be matched is named instead of guessed at.
 */
export function payrollHourUpdates(roster, people) {
  const updates = [];
  const problems = [];
  for (const person of people) {
    const pay = roster.find((compensation) => compensation.employee_uuid === person.employeeUuid);
    if (!pay) {
      problems.push(`${person.name} isn't on this payroll in Gusto, so their hours weren't added.`);
      continue;
    }
    if (pay.excluded) {
      problems.push(`${person.name} is skipped on this payroll in Gusto, so their hours weren't added.`);
      continue;
    }
    const lines = pay.hourly_compensations ?? [];
    const regular = hourLine(lines, /^regular/i, person.jobUuid);
    const overtime = hourLine(lines, /^overtime$/i, person.jobUuid);
    if (!regular || (person.overtimeMinutes > 0 && !overtime)) {
      problems.push(`${person.name}: Gusto has no matching hours line on this payroll, so their hours weren't added.`);
      continue;
    }
    if (regular.flsa_status && !HOURLY_FLSA.has(regular.flsa_status)) {
      problems.push(`${person.name} isn't paid by the hour in Gusto, so their hours weren't added.`);
      continue;
    }
    const hourly = [{ name: regular.name, hours: minutesToHours(person.regularMinutes), job_uuid: regular.job_uuid }];
    // Overtime is always set, so a stale number can't survive from an earlier sync.
    if (overtime) hourly.push({ name: overtime.name, hours: minutesToHours(person.overtimeMinutes), job_uuid: overtime.job_uuid });
    updates.push({ employee_uuid: person.employeeUuid, hourly_compensations: hourly });
  }
  return { updates, problems };
}

/** Store staff the draft pays for hours who have no approved shifts here, such as Gusto's default hours. */
export function othersWithHours(roster, storeStaff, people) {
  const handled = new Set(people.map((person) => person.employeeUuid));
  return storeStaff
    .filter((member) => !handled.has(member.gusto_employee_uuid))
    .filter((member) => {
      const pay = roster.find((compensation) => compensation.employee_uuid === member.gusto_employee_uuid);
      return pay && !pay.excluded && (pay.hourly_compensations ?? []).some((line) => Number(line.hours) > 0);
    })
    .map((member) => `${member.display_name} has hours on the Gusto draft but no approved shifts here.`);
}

/** Puts each person's approved hours for the period on the draft payroll. */
async function fillPayroll(db, client, payroll) {
  const people = periodTotals(await loadEntries(db, payroll.start, payroll.end), payroll.start, payroll.end);
  const roster = await client.prepareDraft(payroll.uuid);
  const { updates, problems } = payrollHourUpdates(roster, people);
  const skipped = updates.length > 0 ? await client.setPayrollHours(payroll.uuid, updates) : [];
  for (const uuid of skipped) {
    const person = people.find((candidate) => candidate.employeeUuid === uuid);
    problems.push(`Gusto didn't take ${person?.name ?? 'one person'}'s hours. Add them in Gusto.`);
  }
  const { results: storeStaff } = await db
    .prepare('SELECT display_name, gusto_employee_uuid FROM staff WHERE store_staff = 1 AND gusto_employee_uuid IS NOT NULL')
    .all();
  return { filled: updates.length - skipped.length, notes: [...problems, ...othersWithHours(roster, storeStaff, people)] };
}

/**
 * For a read-only connection: a pay period's approved hours per person, to type
 * into Gusto by hand. Nobody needs a Gusto link for that, and nothing is marked
 * as sent, because the admin can't see whether it was typed in.
 */
export function handEntryTotals(entries, start, end) {
  const { blockers, toSend } = planSend(entries, start, end, { needsGustoLink: false });
  const people = new Map();
  // planSend keeps unfinished shifts so it can report them. They're never counted here.
  for (const entry of toSend.filter((shift) => shift.status === 'approved' && shift.clock_out_at)) {
    const person = people.get(entry.staff_id) ?? { name: entry.display_name, shifts: 0, regularMinutes: 0, overtimeMinutes: 0 };
    person.shifts += 1;
    person.regularMinutes += entry.regularMinutes;
    person.overtimeMinutes += entry.overtimeMinutes;
    people.set(entry.staff_id, person);
  }
  return { blockers, people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function loadHandEntry(db, { start, end }) {
  return handEntryTotals(await loadEntries(db, start, end), start, end);
}

export async function loadPlan(db, client, payroll, actor) {
  const { start, end } = payroll;
  let entries = await loadEntries(db, start, end);
  const first = planSend(entries, start, end);
  const undecided = await reconcile(db, client, first.interrupted, start, end, actor);
  if (first.interrupted.length > 0) entries = await loadEntries(db, start, end);

  const plan = planSend(entries, start, end);
  plan.alreadyKnown = entries.map((entry) => entry.gusto_time_sheet_uuid).filter(Boolean);
  plan.sentShiftKeys = entries
    .filter((entry) => entry.push_state === 'pushed')
    .map((entry) => shiftKey(entry.gusto_employee_uuid, entry.clock_in_at))
    .filter(Boolean);
  for (const entry of undecided) plan.blockers.push(`${describeShift(entry)}: still being checked with Gusto. Try again in two minutes.`);

  if (plan.toSend.length > 0) {
    plan.gusto = await timeSheetsFor(client).list(start, end);
    if (plan.gusto.source === 'none') {
      plan.blockers.push("Gusto's time tracking isn't set up for this company, so there's nowhere to put the hours.");
    }
    if (plan.gusto.members) {
      const missing = new Set(plan.toSend.filter((entry) => !plan.gusto.members.has(entry.gusto_employee_uuid)).map((entry) => entry.display_name));
      for (const name of missing) plan.blockers.push(`${name} isn't set up for time tracking in Gusto.`);
    }
    const foreign = foreignRecords(plan.gusto.records, plan, start, end);
    if (foreign.length > 0) {
      plan.blockers.push(
        `Gusto already has ${foreign.length} ${foreign.length === 1 ? 'shift' : 'shifts'} for this period that didn't come from this admin, such as clock-ins on Gusto's own clock. Sending could pay those hours twice.`,
      );
    }
  }
  return plan;
}

/**
 * Sends up to one batch, staying inside a Worker's limit on outbound requests.
 * The page calls this until `remaining` is 0. The plan is rebuilt from the
 * database every time, so nothing the browser sends can change what goes out.
 */
export async function sendBatch(db, client, { payrollUuid, actor, today }) {
  const payroll = (await draftPayrolls(client, today)).find((candidate) => candidate.uuid === payrollUuid);
  if (!payroll) return { blockers: ['That draft payroll is no longer open in Gusto.'] };

  const plan = await loadPlan(db, client, payroll, actor);
  if (plan.blockers.length > 0) return { blockers: plan.blockers };
  if (plan.toSend.length === 0 && plan.alreadySent === 0) return { sent: 0, remaining: 0, synced: false, nothing: true };

  // With nothing left to send, this still syncs. That's the way back when a send
  // was cut off on its last shift: the shift reached Gusto, but no sync followed.
  const sheets = timeSheetsFor(client);
  const batch = plan.toSend.slice(0, SEND_BATCH_SIZE);
  const warnings = [];
  for (const entry of batch) {
    // Marked first, so a crash can't leave a sent shift looking unsent. The
    // version check also catches someone reopening the shift during this run.
    const { meta } = await db
      .prepare(
        `UPDATE time_entries SET push_state = 'pushing', updated_at = ?
         WHERE id = ? AND version = ? AND status = 'approved' AND push_state IS NULL`,
      )
      .bind(new Date().toISOString(), entry.id, entry.version)
      .run();
    if (meta.changes !== 1) throw new GustoError(`${describeShift(entry)} changed while sending. Try again.`, { definite: true });

    let written;
    try {
      written = await sheets.create(entry, plan.gusto);
    } catch (err) {
      if (err instanceof GustoError && err.definite) {
        await db.prepare('UPDATE time_entries SET push_state = NULL WHERE id = ?').bind(entry.id).run();
        throw new GustoError(`Gusto refused ${describeShift(entry)}: ${err.message}`, { definite: true });
      }
      throw new GustoError(`No clear answer from Gusto for ${describeShift(entry)}. Wait two minutes and send again; it won't be sent twice.`);
    }
    await recordPushed(db, entry, written.id, actor);
    // A warning means the hours landed but something else didn't, so it's shown, not swallowed.
    if (written.warning) warnings.push(`${describeShift(entry)}: ${written.warning}`);
  }

  const remaining = plan.toSend.length - batch.length;
  if (remaining > 0) return { sent: batch.length, remaining, warnings };

  if (!sheets.sync) {
    if (!client.fillsPayroll) return { sent: batch.length, remaining: 0, inTimeTracking: true, warnings };
    // Every shift is in Gusto now, so the draft gets the whole period's totals.
    // Gusto replaces hours rather than adding, so doing this again is harmless.
    try {
      const fill = await fillPayroll(db, client, payroll);
      return { sent: batch.length, remaining: 0, inTimeTracking: true, onPayroll: true, filled: fill.filled, payrollNotes: fill.notes, warnings };
    } catch (err) {
      if (!(err instanceof GustoError)) throw err;
      return { sent: batch.length, remaining: 0, inTimeTracking: true, onPayroll: false, fillError: err.message, warnings };
    }
  }
  try {
    await sheets.sync(payroll);
    return { sent: batch.length, remaining: 0, synced: true, warnings };
  } catch (err) {
    if (!(err instanceof GustoError)) throw err;
    return { sent: batch.length, remaining: 0, synced: false, syncError: err.message, warnings };
  }
}
