import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTimeRecord, readTimeRecordList } from './gusto-records.mjs';

test('reads the third-party shape the CLI documents', () => {
  const { source, records } = readTimeRecordList({ source: 'third_party', timesheets: [{ id: 'TimeSheet:abc' }] });
  assert.equal(source, 'third_party');
  assert.equal(records.length, 1);
});

test('reads other list names and bare arrays', () => {
  assert.equal(readTimeRecordList({ source: 'native', shifts: [{}, {}] }).records.length, 2);
  assert.equal(readTimeRecordList([{}]).source, 'unknown');
});

test('an unrecognized payload is flagged, not mistaken for an empty period', () => {
  assert.deepEqual(readTimeRecordList(null), { source: 'unknown', records: [], recognized: false });
  assert.equal(readTimeRecordList({ source: 'native' }).recognized, false);
  assert.equal(readTimeRecordList({ source: 'native', stuff: [{}] }).recognized, false);
});

test('a real empty list is recognized', () => {
  assert.deepEqual(readTimeRecordList({ source: 'native', shifts: [] }), { source: 'native', records: [], recognized: true });
});

test('normalizes a documented Gusto time sheet', () => {
  const row = normalizeTimeRecord(
    {
      uuid: 'u1',
      status: 'approved',
      entity_uuid: 'e1',
      shift_started_at: '2026-06-01T14:00:00Z',
      shift_ended_at: '2026-06-01T22:00:00Z',
      entries: [
        { hours_worked: '7.500', pay_classification: 'Regular' },
        { hours_worked: '0.500', pay_classification: 'Overtime' },
      ],
    },
    'third_party',
  );
  assert.equal(row.recordId, 'u1');
  assert.equal(row.employeeUuid, 'e1');
  assert.equal(row.startedOn, '2026-06-01');
  assert.equal(row.hours, 8);
  assert.equal(row.status, 'approved');
});

test('keeps the raw record when fields are unrecognized', () => {
  const row = normalizeTimeRecord({ id: 'x', surprise: { nested: true } }, 'native');
  assert.equal(row.startedAt, null);
  assert.equal(row.hours, null);
  assert.deepEqual(JSON.parse(row.rawJson), { id: 'x', surprise: { nested: true } });
});

test('a bad timestamp becomes null instead of throwing', () => {
  assert.equal(normalizeTimeRecord({ id: 'x', start: 'soon' }, 'native').startedAt, null);
});

test('builds a name from nested employee fields', () => {
  const row = normalizeTimeRecord({ id: 'x', employee: { uuid: 'e', first_name: 'A', last_name: 'B' } }, 'native');
  assert.equal(row.employeeName, 'A B');
  assert.equal(row.employeeUuid, 'e');
});
