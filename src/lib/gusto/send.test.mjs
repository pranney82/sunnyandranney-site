import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTE_PREFIX,
  foreignRecords,
  handEntryTotals,
  othersWithHours,
  payrollHourUpdates,
  payrollToWorkOn,
  periodTotals,
  planSend,
  recordTimeArgs,
  shiftKey,
  timeRecordsFrom,
  timeSheetBody,
} from './send.mjs';
import { GustoError } from './oauth.mjs';

const shift = (id, day, hours, extra = {}) => {
  const start = new Date(`${day}T14:00:00.000Z`);
  return {
    id,
    staff_id: 's1',
    display_name: 'Nikki',
    overtime_eligible: 1,
    clock_in_at: start.toISOString(),
    clock_out_at: new Date(start.getTime() + hours * 3600000).toISOString(),
    status: 'approved',
    push_state: null,
    gusto_employee_uuid: 'emp',
    gusto_job_uuid: 'job',
    ...extra,
  };
};
const PERIOD = ['2026-10-11', '2026-10-24'];

test('a clean period lists its shifts with overtime worked out', () => {
  const week = ['12', '13', '14', '15', '16'].map((day, i) => shift(`n${i}`, `2026-10-${day}`, 9));
  const plan = planSend(week, ...PERIOD);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.toSend.length, 5);
  assert.equal(plan.toSend[4].overtimeMinutes, 300);
});

test('overtime counts hours from a week that began before the period', () => {
  const entries = [shift('old', '2026-10-05', 40), shift('new', '2026-10-09', 0.5), shift('in', '2026-10-11', 8)];
  assert.equal(planSend(entries, '2026-10-09', '2026-10-24').toSend.find((entry) => entry.id === 'new').overtimeMinutes, 30);
});

test('anything unfinished blocks the whole period', () => {
  const blocked = (entry) => planSend([entry], ...PERIOD).blockers;
  assert.match(blocked(shift('a', '2026-10-12', 8, { clock_out_at: null }))[0], /no clock-out/);
  assert.match(blocked(shift('a', '2026-10-12', 8, { status: 'pending' }))[0], /not approved/);
  assert.match(blocked(shift('a', '2026-10-12', 8, { gusto_job_uuid: null }))[0], /not linked/);
});

test('shifts outside the period neither block it nor get sent', () => {
  const plan = planSend([shift('out', '2026-09-30', 8, { status: 'pending' }), shift('in', '2026-10-12', 8)], ...PERIOD);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.toSend.map((entry) => entry.id), ['in']);
});

test('sent shifts are never sent again, and half-sent ones are held apart', () => {
  const plan = planSend([shift('sent', '2026-10-12', 8, { push_state: 'pushed' }), shift('half', '2026-10-13', 8, { push_state: 'pushing' }), shift('new', '2026-10-14', 8)], ...PERIOD);
  assert.deepEqual(plan.toSend.map((entry) => entry.id), ['new']);
  assert.deepEqual(plan.interrupted.map((entry) => entry.id), ['half']);
  assert.equal(plan.alreadySent, 1);
});

test('a time sheet carries what Gusto needs and its own id for matching later', () => {
  const body = timeSheetBody({ ...shift('e1', '2026-10-12', 9), regularMinutes: 480, overtimeMinutes: 60 });
  assert.equal(body.entity_uuid, 'emp');
  assert.equal(body.entity_type, 'Employee');
  assert.equal(body.job_uuid, 'job');
  assert.equal(body.time_zone, 'America/New_York');
  assert.deepEqual(body.entries, [
    { hours_worked: '8.000', pay_classification: 'Regular' },
    { hours_worked: '1.000', pay_classification: 'Overtime' },
  ]);
  assert.deepEqual(body.metadata, { source: 'sunny-and-ranney-admin', entry_id: 'e1' });
  assert.equal(timeSheetBody({ ...shift('e2', '2026-10-12', 8), regularMinutes: 480, overtimeMinutes: 0 }).entries.length, 1);
});

test('a period with nothing in it has nothing to send and nothing sent', () => {
  const plan = planSend([], ...PERIOD);
  assert.deepEqual(plan.toSend, []);
  assert.equal(plan.alreadySent, 0);
});

test('hand entry adds up each person and needs no Gusto link', () => {
  const unlinked = { gusto_employee_uuid: null, gusto_job_uuid: null };
  const nikki = ['12', '13', '14', '15', '16'].map((day, i) => shift(`n${i}`, `2026-10-${day}`, 9, unlinked));
  const zed = shift('z1', '2026-10-12', 4, { staff_id: 's2', display_name: 'Aaron' });
  const { blockers, people } = handEntryTotals([...nikki, zed], ...PERIOD);
  assert.deepEqual(blockers, []);
  assert.deepEqual(people.map((person) => person.name), ['Aaron', 'Nikki']);
  assert.equal(people[0].regularMinutes, 240);
  assert.equal(people[1].shifts, 5);
  assert.equal(people[1].regularMinutes + people[1].overtimeMinutes, 45 * 60);
  assert.equal(people[1].overtimeMinutes, 5 * 60);
});

test('hand entry names unfinished shifts and never counts their hours', () => {
  const { blockers, people } = handEntryTotals(
    [
      shift('a', '2026-10-12', 8, { status: 'pending' }),
      shift('b', '2026-10-13', 8, { clock_out_at: null }),
      shift('c', '2026-10-14', 6),
    ],
    ...PERIOD,
  );
  assert.equal(blockers.length, 2);
  assert.match(blockers[0], /not approved/);
  assert.match(blockers[1], /no clock-out/);
  assert.equal(people.length, 1);
  assert.equal(people[0].shifts, 1);
  assert.equal(people[0].regularMinutes, 360);
});

test('hand entry lists nobody when no shift is finished', () => {
  const { people } = handEntryTotals([shift('a', '2026-10-12', 8, { status: 'pending' })], ...PERIOD);
  assert.deepEqual(people, []);
});

test('record_time gets the shift in store time with its offset, and a note only where Gusto keeps one', () => {
  const entry = {
    id: 'e1',
    gusto_employee_uuid: 'emp',
    gusto_job_uuid: 'job',
    clock_in_at: '2026-11-02T14:00:00.000Z',
    clock_out_at: '2026-11-02T22:00:00.000Z',
  };
  assert.deepEqual(recordTimeArgs(entry, 'member', { withNote: true }), {
    company_member_uuid: 'member',
    job_uuid: 'job',
    shift_started_at: '2026-11-02T09:00:00-05:00',
    shift_ended_at: '2026-11-02T17:00:00-05:00',
    timezone: 'America/New_York',
    on_existing: 'add',
    note: `${NOTE_PREFIX}e1`,
  });
  assert.equal('note' in recordTimeArgs(entry, 'member'), false);
});

test("Gusto's own time tracking gives every worker's member id, even with no shifts", () => {
  const { source, records, members } = timeRecordsFrom({
    source: 'native',
    shifts: [{ id: 'sh1', employeeUuid: 'emp1', companyMemberUuid: 'm1', clockInTimestamp: '2026-11-02T09:00:00-05:00', date: '2026-11-02' }],
    workers: [
      { employeeUuid: 'emp1', companyMemberUuid: 'm1' },
      { employeeUuid: 'emp2', companyMemberUuid: 'm2' },
      { contractorUuid: 'c1', employeeUuid: null, companyMemberUuid: 'm3' },
    ],
  });
  assert.equal(source, 'native');
  assert.deepEqual([...members], [['emp1', 'm1'], ['emp2', 'm2']]);
  assert.deepEqual(records, [
    { id: 'sh1', entryId: null, ours: false, rejected: false, startedAt: '2026-11-02T09:00:00-05:00', day: '2026-11-02', employeeUuid: 'emp1' },
  ]);
});

test('a third-party tracker gives member ids only for people with time sheets', () => {
  const { records, members } = timeRecordsFrom({
    source: 'third_party',
    timesheets: [{ id: 't1', employeeUuid: 'emp1', companyMemberUuid: 'm1', shiftStartedAt: '2026-11-02T06:00:00-08:00' }],
  });
  assert.deepEqual([...members], [['emp1', 'm1']]);
  assert.equal(records[0].day, '2026-11-02');
  assert.equal(shiftKey('emp1', records[0].startedAt), shiftKey('emp1', '2026-11-02T14:00:00.000Z'));
});

test('no time tracking reads as empty, and an unknown answer stops the send', () => {
  assert.deepEqual(timeRecordsFrom({ source: 'none' }).records, []);
  assert.throws(() => timeRecordsFrom({ source: 'native' }), GustoError);
  assert.throws(() => timeRecordsFrom({ timesheets: [] }), GustoError);
  assert.throws(() => timeRecordsFrom(null), GustoError);
});

test("only hours for people being sent, that this admin didn't send, block a period", () => {
  const plan = {
    alreadyKnown: ['known'],
    sentShiftKeys: [shiftKey('emp1', '2026-11-03T14:00:00.000Z')],
    toSend: [{ gusto_employee_uuid: 'emp1' }],
  };
  const record = (extra) => ({ id: 'x', ours: false, rejected: false, startedAt: '2026-11-04T14:00:00.000Z', day: '2026-11-04', employeeUuid: 'emp1', ...extra });
  const found = foreignRecords(
    [
      record({ id: 'clocked-in-on-gusto' }),
      record({ id: 'known' }),
      record({ id: 'sent-before', startedAt: '2026-11-03T09:00:00-05:00', day: '2026-11-03' }),
      record({ id: 'someone-else', employeeUuid: 'emp9' }),
      record({ id: 'nobody-named', employeeUuid: null }),
      record({ id: 'rejected', rejected: true }),
      record({ id: 'outside', day: '2026-10-20' }),
    ],
    plan,
    '2026-11-01',
    '2026-11-14',
  );
  assert.deepEqual(found.map((r) => r.id), ['clocked-in-on-gusto', 'nobody-named']);
});

test('period totals cover every approved shift, sent or not, with overtime from the week before', () => {
  // A period starting mid-week, on Friday Oct 9. Monday Oct 5 holds 36 hours of that same workweek.
  const entries = [
    shift('before', '2026-10-05', 36),
    shift('a', '2026-10-09', 8, { push_state: 'pushed' }),
    shift('b', '2026-10-12', 8),
    shift('pending', '2026-10-13', 8, { status: 'pending' }),
    shift('other', '2026-10-12', 5, { staff_id: 's2', display_name: 'BJ', gusto_employee_uuid: 'emp2', gusto_job_uuid: 'job2' }),
    shift('unlinked', '2026-10-12', 5, { staff_id: 's3', display_name: 'New', gusto_employee_uuid: null }),
  ];
  const totals = periodTotals(entries, '2026-10-09', '2026-10-22');
  // Oct 9 brings Nikki's week to 44 hours, so 4 are overtime; Oct 12 starts a fresh week.
  assert.deepEqual(totals, [
    { name: 'Nikki', employeeUuid: 'emp', jobUuid: 'job', regularMinutes: 12 * 60, overtimeMinutes: 4 * 60 },
    { name: 'BJ', employeeUuid: 'emp2', jobUuid: 'job2', regularMinutes: 5 * 60, overtimeMinutes: 0 },
  ]);
});

const rosterLine = (name, hours, extra = {}) => ({ name, hours, job_uuid: 'job', flsa_status: 'Nonexempt', ...extra });

test('payroll hours go on Gusto\'s own lines for the right job, overtime included even at zero', () => {
  const roster = [
    {
      employee_uuid: 'emp',
      hourly_compensations: [
        rosterLine('Regular Hours', '80.000'),
        rosterLine('Overtime', '3.000'),
        rosterLine('Double overtime', '0.000'),
        rosterLine('Regular Hours', '0.000', { job_uuid: 'other-job' }),
      ],
    },
  ];
  const { updates, problems } = payrollHourUpdates(roster, [{ name: 'Nikki', employeeUuid: 'emp', jobUuid: 'job', regularMinutes: 1470, overtimeMinutes: 0 }]);
  assert.deepEqual(problems, []);
  assert.deepEqual(updates, [
    {
      employee_uuid: 'emp',
      hourly_compensations: [
        { name: 'Regular Hours', hours: '24.500', job_uuid: 'job' },
        { name: 'Overtime', hours: '0.000', job_uuid: 'job' },
      ],
    },
  ]);
});

test('anyone who cannot be matched to the payroll is named, never guessed at', () => {
  const person = (name, employeeUuid, extra = {}) => ({ name, employeeUuid, jobUuid: 'job', regularMinutes: 60, overtimeMinutes: 0, ...extra });
  const roster = [
    { employee_uuid: 'skipped', excluded: true, hourly_compensations: [rosterLine('Regular Hours', '0')] },
    { employee_uuid: 'salaried', hourly_compensations: [rosterLine('Regular Hours', '0', { flsa_status: 'Exempt' })] },
    { employee_uuid: 'no-ot-line', hourly_compensations: [rosterLine('Regular Hours', '0')] },
    { employee_uuid: 'two-jobs', hourly_compensations: [rosterLine('Regular Hours', '0', { job_uuid: 'x' }), rosterLine('Regular Hours', '0', { job_uuid: 'y' })] },
  ];
  const { updates, problems } = payrollHourUpdates(roster, [
    person('Gone', 'missing'),
    person('Skip', 'skipped'),
    person('Sal', 'salaried'),
    person('Ot', 'no-ot-line', { overtimeMinutes: 30 }),
    person('Two', 'two-jobs'),
  ]);
  assert.deepEqual(updates, []);
  assert.equal(problems.length, 5);
  assert.match(problems[0], /Gone isn't on this payroll/);
  assert.match(problems[2], /Sal isn't paid by the hour/);
});

test('store staff with hours on the draft but no shifts here are called out, such as default hours', () => {
  const roster = [
    { employee_uuid: 'emp', hourly_compensations: [rosterLine('Regular Hours', '24.5')] },
    { employee_uuid: 'default', hourly_compensations: [rosterLine('Regular Hours', '80.000')] },
    { employee_uuid: 'zero', hourly_compensations: [rosterLine('Regular Hours', '0.000')] },
    { employee_uuid: 'office', hourly_compensations: [rosterLine('Regular Hours', '40.000')] },
  ];
  const storeStaff = [
    { display_name: 'Nikki', gusto_employee_uuid: 'emp' },
    { display_name: 'Ian', gusto_employee_uuid: 'default' },
    { display_name: 'Zed', gusto_employee_uuid: 'zero' },
  ];
  assert.deepEqual(othersWithHours(roster, storeStaff, [{ employeeUuid: 'emp' }]), ['Ian has hours on the Gusto draft but no approved shifts here.']);
});

test('payrollToWorkOn picks the period whose hours are due, then the current one', () => {
  const drafts = [
    { uuid: 'old', start: '2026-10-11', end: '2026-10-24' },
    { uuid: 'ended', start: '2026-10-25', end: '2026-11-07' },
    { uuid: 'now', start: '2026-11-08', end: '2026-11-21' },
    { uuid: 'next', start: '2026-11-22', end: '2026-12-05' },
  ];
  assert.equal(payrollToWorkOn(drafts, '2026-11-08').uuid, 'ended');
  assert.equal(payrollToWorkOn(drafts.slice(2), '2026-11-08').uuid, 'now');
  assert.equal(payrollToWorkOn(drafts.slice(3), '2026-11-08').uuid, 'next');
  assert.equal(payrollToWorkOn([], '2026-11-08'), null);
});
