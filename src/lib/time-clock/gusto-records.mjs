/**
 * Turns `gusto timesheet list` output into rows for gusto_time_records.
 *
 * Gusto does not publish the shape of native shift records, only that the
 * payload carries `source` and a list. Field lookups are therefore tolerant,
 * and the raw record is always kept so nothing is lost if a name differs.
 */
import { localDate } from './hours.mjs';

const LIST_KEYS = ['timesheets', 'time_sheets', 'shifts', 'time_records', 'records'];

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

function hoursFrom(record) {
  if (Array.isArray(record.entries)) {
    return record.entries.reduce((sum, entry) => sum + (Number(entry.hours_worked) || 0), 0);
  }
  const direct = Number(first(record.hours_worked, record.total_hours, record.hours));
  return Number.isFinite(direct) ? direct : null;
}

function nameFrom(record) {
  const person = record.employee ?? record.worker ?? record.entity ?? {};
  const joined = [person.first_name ?? record.first_name, person.last_name ?? record.last_name]
    .filter(Boolean)
    .join(' ');
  return first(record.employee_name, record.worker_name, person.name, joined) ?? null;
}

function isoOrNull(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * `recognized` is false when the payload has no list this code knows about.
 * Callers must not read that as "no records": the push step relies on this to
 * tell an empty period from a response it could not understand.
 *
 * @returns {{ source: string, records: unknown[], recognized: boolean }}
 */
export function readTimeRecordList(data) {
  if (Array.isArray(data)) return { source: 'unknown', records: data, recognized: true };
  if (!data || typeof data !== 'object') return { source: 'unknown', records: [], recognized: false };
  const key = LIST_KEYS.find((candidate) => Array.isArray(data[candidate]));
  return { source: String(data.source ?? 'unknown'), records: key ? data[key] : [], recognized: Boolean(key) };
}

export function normalizeTimeRecord(record, source) {
  const person = record.employee ?? record.worker ?? record.entity ?? {};
  const started = isoOrNull(first(record.shift_started_at, record.started_at, record.start_time, record.clock_in, record.start));
  const ended = isoOrNull(first(record.shift_ended_at, record.ended_at, record.end_time, record.clock_out, record.end));
  return {
    recordId: first(record.uuid, record.id) ?? null,
    source,
    employeeUuid: first(record.entity_uuid, record.employee_uuid, person.uuid) ?? null,
    employeeName: nameFrom(record),
    startedAt: started,
    endedAt: ended,
    startedOn: started ? localDate(started) : null,
    hours: hoursFrom(record),
    status: first(record.status, record.state) ?? null,
    rawJson: JSON.stringify(record),
  };
}
