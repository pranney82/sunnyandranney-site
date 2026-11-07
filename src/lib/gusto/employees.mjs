/** Keeps the staff table in step with Gusto's employee list. */
import { GustoError } from './oauth.mjs';

const REFRESH_AFTER_MS = 5 * 60 * 1000;

export function primaryJobUuid(employee) {
  const jobs = employee.jobs ?? [];
  if (jobs.length === 1) return jobs[0].uuid ?? null;
  return jobs.find((job) => job.primary)?.uuid ?? null;
}

export function employeeName(employee) {
  const first = employee.preferred_first_name || employee.first_name || '';
  return [first, employee.last_name].filter(Boolean).join(' ').trim();
}

/**
 * New people start inactive and not store staff: the Gusto account may hold more
 * than the store, so a manager chooses. Terminated people come off the clock, and
 * a manager's edits to a name stay.
 */
export async function syncEmployees(db, client) {
  const employees = await client.listEmployees();
  if (employees.length === 0) throw new GustoError('Gusto returned no employees, so nothing was changed.');

  const now = new Date().toISOString();
  const statements = employees
    .filter((employee) => employee.uuid && employeeName(employee))
    .map((employee) =>
      db
        .prepare(
          `INSERT INTO staff (id, display_name, gusto_employee_uuid, gusto_job_uuid, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(gusto_employee_uuid) DO UPDATE SET
             gusto_job_uuid = excluded.gusto_job_uuid,
             active = CASE WHEN ? = 1 THEN 0 ELSE staff.active END,
             updated_at = excluded.updated_at`,
        )
        .bind(crypto.randomUUID(), employeeName(employee), employee.uuid, primaryJobUuid(employee), now, now, employee.terminated === true ? 1 : 0),
    );
  statements.push(db.prepare('UPDATE gusto_connection SET employees_synced_at = ? WHERE id = 1').bind(now));
  await db.batch(statements);
  return employees.length;
}

/** Syncs unless that was just done, so reloading a page doesn't hammer Gusto. */
export async function syncEmployeesIfStale(db, client, connection, now = Date.now()) {
  const last = connection.employees_synced_at ? Date.parse(connection.employees_synced_at) : 0;
  if (now - last < REFRESH_AFTER_MS) return false;
  await syncEmployees(db, client);
  return true;
}
