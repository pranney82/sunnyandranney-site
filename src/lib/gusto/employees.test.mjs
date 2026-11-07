import assert from 'node:assert/strict';
import test from 'node:test';
import { employeeName, primaryJobUuid, syncEmployeesIfStale } from './employees.mjs';

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
