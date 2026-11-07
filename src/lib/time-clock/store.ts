import { addDays, classifyEntries, localInputToUtc } from '@/lib/time-clock/hours.mjs';

export interface StaffRow {
  id: string;
  display_name: string;
  email: string | null;
  pin_hash: string | null;
  pin_salt: string | null;
  gusto_employee_uuid: string | null;
  gusto_job_uuid: string | null;
  overtime_eligible: number;
  active: number;
  store_staff: number;
}

export interface TimeEntryRow {
  id: string;
  staff_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  status: 'pending' | 'approved' | 'rejected';
  source: 'clock' | 'manual';
  note: string;
  version: number;
  approved_by: string | null;
  approved_at: string | null;
  push_state: 'pushing' | 'pushed' | null;
  display_name: string;
  email: string | null;
  overtime_eligible: number;
}

export interface GustoRecordRow {
  record_id: string;
  source: string;
  employee_name: string | null;
  gusto_employee_uuid: string | null;
  started_at: string | null;
  ended_at: string | null;
  started_on: string | null;
  hours: number | null;
  status: string | null;
}

export interface PayRow {
  payroll_uuid: string;
  check_date: string;
  period_start: string | null;
  period_end: string | null;
  kind: 'regular' | 'off_cycle' | 'reversal';
  reversed: number;
  gross_cents: number;
  regular_hours: number;
  overtime_hours: number;
  time_off_hours: number;
  imported_at: string;
  display_name: string;
}

export interface VersionedId {
  id: string;
  version: number;
}

const nowIso = () => new Date().toISOString();

/**
 * Appends an audit row only if the UPDATE or INSERT before it in the same batch
 * changed a row. A batch is one transaction, so the history can't miss a change
 * or record one that didn't happen.
 */
function eventStatement(db: D1Database, entryId: string, action: string, actor: string, detail: object) {
  return db
    .prepare(
      `INSERT INTO time_entry_events (entry_id, action, actor, detail, created_at)
       SELECT ?, ?, ?, ?, ? WHERE changes() > 0`,
    )
    .bind(entryId, action, actor, JSON.stringify(detail), nowIso());
}

const NOT_OWN_SHIFT = `staff_id NOT IN (SELECT id FROM staff WHERE lower(email) = ?)`;

const NO_OVERLAP = `NOT EXISTS (
  SELECT 1 FROM time_entries other
  WHERE other.staff_id = ?
    AND other.id <> ?
    AND other.status <> 'rejected'
    AND other.clock_in_at < ?
    AND COALESCE(other.clock_out_at, '9999') > ?
)`;

// ─── Staff ───────────────────────────────────────────────────

export async function listStaff(db: D1Database, activeOnly = false): Promise<StaffRow[]> {
  const where = activeOnly ? 'WHERE active = 1' : '';
  const { results } = await db.prepare(`SELECT * FROM staff ${where} ORDER BY active DESC, display_name`).all<StaffRow>();
  return results;
}

export function getStaff(db: D1Database, id: string): Promise<StaffRow | null> {
  return db.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first<StaffRow>();
}

export async function createStaff(
  db: D1Database,
  input: { name: string; email: string | null; overtimeEligible: boolean; pin: { hash: string; salt: string } | null },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO staff (id, display_name, email, overtime_eligible, pin_hash, pin_salt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.name,
      input.email,
      input.overtimeEligible ? 1 : 0,
      input.pin?.hash ?? null,
      input.pin?.salt ?? null,
      now,
      now,
    )
    .run();
}

export async function updateStaff(
  db: D1Database,
  id: string,
  input: {
    name: string;
    email: string | null;
    overtimeEligible: boolean;
    active: boolean;
    storeStaff: boolean;
    pin: { hash: string; salt: string } | null;
  },
): Promise<boolean> {
  const current = await getStaff(db, id);
  if (!current) return false;

  const update = db
    .prepare(
      `UPDATE staff SET display_name = ?, email = ?, overtime_eligible = ?, active = ?, store_staff = ?,
         pin_hash = COALESCE(?, pin_hash), pin_salt = COALESCE(?, pin_salt), updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.name,
      input.email,
      input.overtimeEligible ? 1 : 0,
      input.active ? 1 : 0,
      input.storeStaff ? 1 : 0,
      input.pin?.hash ?? null,
      input.pin?.salt ?? null,
      nowIso(),
      id,
    );

  const statements = [update];
  if (input.storeStaff && !current.store_staff) {
    // Their past pay wasn't read, so every payroll needs reading again.
    statements.push(db.prepare('DELETE FROM gusto_pay_read'));
  } else if (!input.storeStaff && current.store_staff && current.gusto_employee_uuid) {
    statements.push(db.prepare('DELETE FROM gusto_pay_records WHERE gusto_employee_uuid = ?').bind(current.gusto_employee_uuid));
  }
  const [result] = await db.batch(statements);
  return result.meta.changes > 0;
}

// ─── Clock ───────────────────────────────────────────────────

/**
 * Counts one PIN attempt. Unlike checkRateLimit in lib/db, which lets requests
 * through on a database error, this throws, so guessing can't go unthrottled.
 */
export async function countPinAttempt(db: D1Database, key: string, max: number, windowSeconds: number): Promise<boolean> {
  const now = Date.now();
  const expiresAt = now + windowSeconds * 1000;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN expires_at < ? THEN 1 ELSE count + 1 END,
         expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END
       RETURNING count`,
    )
    .bind(key, expiresAt, now, now, expiresAt)
    .first<{ count: number }>();
  return row !== null && row.count <= max;
}

/** Who is on the clock right now, for the kiosk screen. */
export async function openShiftsByStaff(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(`SELECT staff_id, clock_in_at FROM time_entries WHERE clock_out_at IS NULL AND status <> 'rejected'`)
    .all<{ staff_id: string; clock_in_at: string }>();
  return new Map(results.map((row) => [row.staff_id, row.clock_in_at]));
}

/** Returns the clock-in time, or null if this person already has an open shift. */
export async function clockIn(db: D1Database, staffId: string, actor: string): Promise<string | null> {
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO time_entries (id, staff_id, clock_in_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, staffId, now, now, now),
      eventStatement(db, id, 'clock_in', actor, { at: now }),
    ]);
    return now;
  } catch (err) {
    if (String(err).includes('UNIQUE')) return null;
    throw err;
  }
}

/** Returns the clock-out time, or null if this person has no open shift. */
export async function clockOut(db: D1Database, staffId: string, actor: string): Promise<string | null> {
  const open = await db
    .prepare(`SELECT id FROM time_entries WHERE staff_id = ? AND clock_out_at IS NULL AND status <> 'rejected'`)
    .bind(staffId)
    .first<{ id: string }>();
  if (!open) return null;

  const now = nowIso();
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE time_entries SET clock_out_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND clock_out_at IS NULL AND status <> 'rejected'`,
      )
      .bind(now, now, open.id),
    eventStatement(db, open.id, 'clock_out', actor, { at: now }),
  ]);
  return update.meta.changes > 0 ? now : null;
}

// ─── Review ──────────────────────────────────────────────────

const ENTRY_SELECT = `
  SELECT e.*, s.display_name, s.email, s.overtime_eligible
  FROM time_entries e JOIN staff s ON s.id = e.staff_id`;

/** Every shift in the workweek starting on this store-local date. */
export async function entriesForWeek(db: D1Database, weekStart: string): Promise<TimeEntryRow[]> {
  const from = localInputToUtc(`${weekStart}T00:00`);
  const to = localInputToUtc(`${addDays(weekStart, 7)}T00:00`);
  const { results } = await db
    .prepare(`${ENTRY_SELECT} WHERE e.clock_in_at >= ? AND e.clock_in_at < ? ORDER BY s.display_name, e.clock_in_at`)
    .bind(from, to)
    .all<TimeEntryRow>();
  return results;
}

export interface EntryHours {
  regularMinutes: number;
  overtimeMinutes: number;
}

/** Rejected shifts don't count toward hours or overtime. */
export function hoursByEntry(entries: TimeEntryRow[]): Map<string, EntryHours> {
  return classifyEntries(entries.filter((entry) => entry.status !== 'rejected'));
}

/** Approves each shift still at the version the manager saw. Returns how many changed. */
export async function approveEntries(db: D1Database, items: VersionedId[], actor: string): Promise<number> {
  if (items.length === 0) return 0;
  const now = nowIso();
  const statements = items.flatMap(({ id, version }) => [
    db
      .prepare(
        `UPDATE time_entries
         SET status = 'approved', approved_by = ?, approved_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'pending' AND clock_out_at IS NOT NULL
           AND push_state IS NULL AND ${NOT_OWN_SHIFT}`,
      )
      .bind(actor, now, now, id, version, actor),
    eventStatement(db, id, 'approve', actor, {}),
  ]);
  const results = await db.batch(statements);
  return results.filter((_, index) => index % 2 === 0).reduce((sum, result) => sum + result.meta.changes, 0);
}

export async function editEntry(
  db: D1Database,
  input: VersionedId & { staffId: string; clockInAt: string; clockOutAt: string; reason: string },
  actor: string,
): Promise<boolean> {
  const now = nowIso();
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE time_entries
         SET clock_in_at = ?, clock_out_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND staff_id = ? AND version = ? AND status = 'pending' AND push_state IS NULL
           AND ${NOT_OWN_SHIFT} AND ${NO_OVERLAP}`,
      )
      .bind(
        input.clockInAt,
        input.clockOutAt,
        now,
        input.id,
        input.staffId,
        input.version,
        actor,
        input.staffId,
        input.id,
        input.clockOutAt,
        input.clockInAt,
      ),
    eventStatement(db, input.id, 'edit', actor, {
      clock_in_at: input.clockInAt,
      clock_out_at: input.clockOutAt,
      reason: input.reason,
    }),
  ]);
  return update.meta.changes > 0;
}

export async function addManualEntry(
  db: D1Database,
  input: { staffId: string; clockInAt: string; clockOutAt: string; reason: string },
  actor: string,
): Promise<boolean> {
  const id = crypto.randomUUID();
  const now = nowIso();
  const [insert] = await db.batch([
    db
      .prepare(
        `INSERT INTO time_entries (id, staff_id, clock_in_at, clock_out_at, source, note, created_at, updated_at)
         SELECT ?, ?, ?, ?, 'manual', ?, ?, ?
         WHERE ? NOT IN (SELECT id FROM staff WHERE lower(email) = ?) AND ${NO_OVERLAP}`,
      )
      .bind(
        id,
        input.staffId,
        input.clockInAt,
        input.clockOutAt,
        input.reason,
        now,
        now,
        input.staffId,
        actor,
        input.staffId,
        id,
        input.clockOutAt,
        input.clockInAt,
      ),
    eventStatement(db, id, 'create', actor, {
      clock_in_at: input.clockInAt,
      clock_out_at: input.clockOutAt,
      reason: input.reason,
    }),
  ]);
  return insert.meta.changes > 0;
}

/** Only shifts still waiting on review can be rejected. Open shifts need a clock-out. */
export async function rejectEntry(db: D1Database, input: VersionedId & { reason: string }, actor: string): Promise<boolean> {
  const now = nowIso();
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE time_entries SET status = 'rejected', version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND status = 'pending' AND clock_out_at IS NOT NULL
           AND push_state IS NULL AND ${NOT_OWN_SHIFT}`,
      )
      .bind(now, input.id, input.version, actor),
    eventStatement(db, input.id, 'reject', actor, { reason: input.reason }),
  ]);
  return update.meta.changes > 0;
}

/** Sends an approved or rejected shift back to pending. Shifts sent to Gusto stay locked. */
export async function reopenEntry(db: D1Database, input: VersionedId & { staffId: string }, actor: string): Promise<boolean> {
  const now = nowIso();
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE time_entries
         SET status = 'pending', approved_by = NULL, approved_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND staff_id = ? AND version = ? AND status <> 'pending' AND push_state IS NULL
           AND ${NOT_OWN_SHIFT}
           AND NOT EXISTS (
             SELECT 1 FROM time_entries other
             WHERE other.staff_id = time_entries.staff_id
               AND other.id <> time_entries.id
               AND other.status <> 'rejected'
               AND other.clock_in_at < time_entries.clock_out_at
               AND COALESCE(other.clock_out_at, '9999') > time_entries.clock_in_at
           )`,
      )
      .bind(now, input.id, input.staffId, input.version, actor),
    eventStatement(db, input.id, 'reopen', actor, {}),
  ]);
  return update.meta.changes > 0;
}

// ─── Gusto history and pay (read-only) ───────────────────────

export async function gustoHistory(
  db: D1Database,
  from: string,
  to: string,
): Promise<{ records: GustoRecordRow[]; truncated: boolean }> {
  const limit = 500;
  const { results } = await db
    .prepare(
      `SELECT record_id, source, employee_name, gusto_employee_uuid, started_at, ended_at, started_on, hours, status
       FROM gusto_time_records
       WHERE started_on >= ? AND started_on <= ?
         AND gusto_employee_uuid IN (SELECT gusto_employee_uuid FROM staff WHERE store_staff = 1)
       ORDER BY started_on DESC, employee_name
       LIMIT ?`,
    )
    .bind(from, to, limit + 1)
    .all<GustoRecordRow>();
  return { records: results.slice(0, limit), truncated: results.length > limit };
}

/** Newest payroll first. The store staff check here hides someone the moment they're unmarked. */
export async function storePayroll(
  db: D1Database,
  from: string,
  to: string,
): Promise<{ rows: PayRow[]; truncated: boolean }> {
  const limit = 2000;
  const { results } = await db
    .prepare(
      `SELECT p.payroll_uuid, p.check_date, p.period_start, p.period_end, p.kind, p.reversed, p.gross_cents,
         p.regular_hours, p.overtime_hours, p.time_off_hours, p.imported_at, s.display_name
       FROM gusto_pay_records p
       JOIN staff s ON s.gusto_employee_uuid = p.gusto_employee_uuid
       WHERE s.store_staff = 1 AND p.check_date >= ? AND p.check_date <= ?
       ORDER BY p.check_date DESC, p.payroll_uuid, s.display_name
       LIMIT ?`,
    )
    .bind(from, to, limit + 1)
    .all<PayRow>();
  return { rows: results.slice(0, limit), truncated: results.length > limit };
}
