import assert from 'node:assert/strict';
import test from 'node:test';
import { departmentName, employeeName, isStoreDepartment, primaryJobUuid, syncEmployees, syncEmployeesIfStale } from './employees.mjs';

test('employeeName prefers the preferred name', () => {
  assert.equal(employeeName({ first_name: 'Nicole', preferred_first_name: 'Nikki', last_name: 'Reed' }), 'Nikki Reed');
  assert.equal(employeeName({ first_name: 'BJ', preferred_first_name: null, last_name: 'Test' }), 'BJ Test');
  assert.equal(employeeName({}), '');
});

test('primaryJobUuid takes a lone job, or the one marked primary, and never guesses', () => {
  assert.equal(primaryJobUuid({ jobs: [{ uuid: 'a' }] }), 'a');
  assert.equal(primaryJobUuid({ jobs: [{ uuid: 'a' }, { uuid: 'b', primary: true }] }), 'b');
  assert.equal(primaryJobUuid({ jobs: [{ uuid: 'a' }, { uuid: 'b' }] }), null);
  assert.equal(primaryJobUuid({}), null);
});

test('syncEmployeesIfStale leaves a recent sync alone', async () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const recent = { employees_synced_at: '2026-11-05T11:58:00Z' };
  assert.equal(await syncEmployeesIfStale(null, null, recent, now), false);
});

test('the store is the Sunny & Ranney department, however it is spelled', () => {
  for (const name of ['Sunny & Ranney', 'sunny & ranney', '  Sunny  &  Ranney ', 'Sunny and Ranney']) assert.equal(isStoreDepartment(name), true, name);
  for (const name of ['Sunshine on a Ranney Day', 'Sunny', '', null, undefined]) assert.equal(isStoreDepartment(name), false, String(name));
  assert.equal(departmentName({ department: 'Sunny & Ranney' }), 'Sunny & Ranney');
  assert.equal(departmentName({ department: '  ' }), null);
  assert.equal(departmentName({ department: null }), null);
  assert.equal(departmentName({ department: { title: 'Sunny & Ranney' } }), 'Sunny & Ranney');
});

/** Records what syncEmployees writes. `current` is the staff already linked to Gusto. */
function fakeDb(current = []) {
  const written = [];
  const db = {
    prepare(sql) {
      return {
        all: async () => ({ results: current }),
        bind: (...args) => ({ sql, args }),
        sql,
        args: [],
      };
    },
    batch: async (statements) => written.push(...statements),
  };
  return { db, written };
}

const person = (uuid, first, department, extra = {}) => ({ uuid, first_name: first, last_name: 'Test', department, jobs: [{ uuid: `job-${uuid}` }], ...extra });

test('Gusto sorts people into store staff and charity, and puts store staff on the clock', async () => {
  const { db, written } = fakeDb();
  const client = {
    listEmployees: async () => [
      person('s1', 'Store', 'Sunny & Ranney'),
      person('c1', 'Charity', 'Sunshine on a Ranney Day'),
      person('s2', 'Gone', 'Sunny & Ranney', { terminated: true }),
    ],
  };
  await syncEmployees(db, client);
  const rows = written.filter((statement) => statement.sql.includes('INSERT INTO staff'));
  // args: id, name, gusto uuid, job, department, terminated, store_staff, active, created, updated
  const byUuid = Object.fromEntries(rows.map((row) => [row.args[2], row.args]));
  assert.deepEqual(byUuid.s1.slice(4, 8), ['Sunny & Ranney', 0, 1, 1]);
  assert.deepEqual(byUuid.c1.slice(4, 8), ['Sunshine on a Ranney Day', 0, 0, 0]);
  // Someone who left is still store staff, so their past pay stays on Payroll, but they're off the clock.
  assert.deepEqual(byUuid.s2.slice(4, 8), ['Sunny & Ranney', 1, 1, 0]);
  // New store staff means past payrolls are read again to pick up their pay.
  assert.ok(written.some((statement) => statement.sql === 'DELETE FROM gusto_pay_read'));
});

test('a sync with no one new to the store leaves payroll reading alone', async () => {
  const { db, written } = fakeDb([{ gusto_employee_uuid: 's1', store_staff: 1 }]);
  await syncEmployees(db, { listEmployees: async () => [person('s1', 'Store', 'Sunny & Ranney'), person('c1', 'Charity', 'Office')] });
  assert.ok(!written.some((statement) => statement.sql === 'DELETE FROM gusto_pay_read'));
});

test('on an update, leaving the company or the store takes someone off the clock, and joining the store puts them on', async () => {
  const { db, written } = fakeDb();
  await syncEmployees(db, { listEmployees: async () => [person('s1', 'Store', 'Sunny & Ranney')] });
  const sql = written.find((statement) => statement.sql.includes('INSERT INTO staff')).sql;
  assert.match(sql, /WHEN excluded\.gusto_terminated = 1 THEN 0/);
  assert.match(sql, /WHEN excluded\.store_staff = 1 AND staff\.store_staff = 0 THEN 1/);
  assert.match(sql, /WHEN excluded\.store_staff = 0 AND staff\.store_staff = 1 THEN 0/);
  assert.match(sql, /ELSE staff\.active/);
});
