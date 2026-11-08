/** Keeps the staff table in step with Gusto's employee list. */
import { GustoError } from './oauth.mjs';

const REFRESH_AFTER_MS = 5 * 60 * 1000;

export function primaryJobUuid(employee) {
  const jobs = employee.jobs ?? [];
  if (jobs.length === 1) return jobs[0].uuid ?? null;
  return jobs.find((job) => job.primary)?.uuid ?? null;
}

/** Gusto's department for store employees. Everyone else in the company works for the charity. */
export const STORE_DEPARTMENT = 'Sunny & Ranney';

const normalizeDepartment = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/\band\b/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export function departmentName(employee) {
  const department = employee.department;
  if (typeof department === 'string') return department.trim() || null;
  return department?.title ?? department?.name ?? null;
}

/** Spacing, case and "and" for "&" don't matter. */
export function isStoreDepartment(name) {
  return normalizeDepartment(name) === normalizeDepartment(STORE_DEPARTMENT);
}

export function employeeName(employee) {
  const first = employee.preferred_first_name || employee.first_name || '';
  return [first, employee.last_name].filter(Boolean).join(' ').trim();
}

/**
 * Gusto decides who is store staff, by department, and who has left. A manager
 * still chooses who is on the time clock, except that people joining the store
 * go on it, and people leaving the store or the company come off it. Everyone
 * stays in the table, so a former employee's past pay still shows on Payroll.
 * A manager's edits to a name stay.
 */
export async function syncEmployees(db, client) {
  const employees = await client.listEmployees();
  if (employees.length === 0) throw new GustoError('Gusto returned no employees, so nothing was changed.');

  const { results: current } = await db
    .prepare('SELECT gusto_employee_uuid, store_staff FROM staff WHERE gusto_employee_uuid IS NOT NULL')
    .all();
  const wasStore = new Map(current.map((row) => [row.gusto_employee_uuid, row.store_staff === 1]));

  const now = new Date().toISOString();
  let joinedStore = false;
  const statements = employees
    .filter((employee) => employee.uuid && employeeName(employee))
    .map((employee) => {
      const department = departmentName(employee);
      const store = isStoreDepartment(department);
      const terminated = employee.terminated === true;
      if (store && !wasStore.get(employee.uuid)) joinedStore = true;
      return db
        .prepare(
          `INSERT INTO staff (id, display_name, gusto_employee_uuid, gusto_job_uuid, gusto_department, gusto_terminated,
             store_staff, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(gusto_employee_uuid) DO UPDATE SET
             gusto_job_uuid = excluded.gusto_job_uuid,
             gusto_department = excluded.gusto_department,
             gusto_terminated = excluded.gusto_terminated,
             store_staff = excluded.store_staff,
             active = CASE
               WHEN excluded.gusto_terminated = 1 THEN 0
               WHEN excluded.store_staff = 1 AND staff.store_staff = 0 THEN 1
               WHEN excluded.store_staff = 0 AND staff.store_staff = 1 THEN 0
               ELSE staff.active
             END,
             updated_at = excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          employeeName(employee),
          employee.uuid,
          primaryJobUuid(employee),
          department,
          terminated ? 1 : 0,
          store ? 1 : 0,
          store && !terminated ? 1 : 0,
          now,
          now,
        );
    });
  // Past pay is only read for store staff, so someone new to the store needs every payroll read again.
  if (joinedStore) statements.push(db.prepare('DELETE FROM gusto_pay_read'));
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
