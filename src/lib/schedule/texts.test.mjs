import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellKey } from './core.mjs';
import {
  formatUsPhone,
  keywordOf,
  normalizeUsPhone,
  planWeekTexts,
  shiftText,
  SIGNUP_BODY,
  smsParts,
  statusFromSentDm,
  statusLabel,
  toGsm,
  upcomingDays,
  weekBody,
  weekParams,
} from './texts.mjs';

const H = (h, m = 0) => h * 60 + m;
const shift = (start, end, label = '') => ({ shift: { start, end, label, away: false }, off: null });
const WEEK = '2026-11-15'; // Sunday
const cellsOf = (entries) => new Map(entries.map(([id, date, cell]) => [cellKey(id, date), cell]));
const signedUp = (id, stopped = false) => ({ id, signup: { phone: '+16785551234', stopped } });

test('US numbers are read the ways people type them', () => {
  for (const typed of ['(678) 555-1234', '678.555.1234', '678-555-1234', '6785551234', '+1 678 555 1234', '1-678-555-1234']) {
    assert.equal(normalizeUsPhone(typed), '+16785551234', typed);
  }
  for (const bad of ['', '555-1234', '078 555 1234', '678 155 1234', '911 555 1234', '+44 20 7946 0958', '678-555-1234 x2', 'call me']) {
    assert.equal(normalizeUsPhone(bad), null, bad);
  }
  assert.equal(formatUsPhone('+16785551234'), '678.555.1234');
});

test('labels become plain SMS characters on one line', () => {
  assert.equal(toGsm('Staci’s “Mart” – day'), 'Staci\'s "Mart" - day');
  // é is a GSM letter, so it stays; emoji and line breaks don't.
  assert.equal(toGsm('Café 🎉\nnight\t shift'), 'Café night shift');
  assert.equal(toGsm('São Paulo'), 'Sao Paulo');
  assert.equal(toGsm('  a   b  '), 'a b');
});

test('a text counts its SMS parts like a phone does', () => {
  assert.equal(smsParts('x'.repeat(160)), 1);
  assert.equal(smsParts('x'.repeat(161)), 2);
  assert.equal(smsParts('x'.repeat(306)), 2);
  assert.equal(smsParts('x'.repeat(307)), 3);
  assert.equal(smsParts('€'.repeat(80)), 1);
  assert.equal(smsParts('€'.repeat(81)), 2);
  assert.equal(smsParts(SIGNUP_BODY), 1);
});

test('shifts read the way the campaign samples do', () => {
  assert.equal(shiftText({ start: H(10), end: H(17), label: '' }), '10a-5p');
  assert.equal(shiftText({ start: H(10, 30), end: H(18), label: '' }), '10:30a-6p');
  assert.equal(shiftText({ start: H(9), end: null, label: '' }), '9a-?');
  assert.equal(shiftText({ start: H(9), end: H(17), label: 'Mart' }), 'Mart 9a-5p');
  assert.equal(shiftText({ start: null, end: null, label: 'Mart' }), 'Mart');
  assert.equal(shiftText({ start: null, end: null, label: '' }), 'Work');
  assert.equal(shiftText({ start: H(12), end: H(24), label: '' }), '12p-12a');
});

test('a full week of shifts fits in one text', () => {
  const days = {};
  for (let i = 0; i < 7; i++) days[`2026-11-${15 + i}`] = '10:30a-10:30p';
  const body = weekBody(weekParams(WEEK, days, true));
  assert.equal(body, `Sunny & Ranney schedule, week of Nov 15 (updated): Sun 10:30a-10:30p, Mon 10:30a-10:30p, Tue 10:30a-10:30p, Wed 10:30a-10:30p, Thu 10:30a-10:30p, Fri 10:30a-10:30p, Sat 10:30a-10:30p. Reply STOP to opt out, HELP for help.`);
  assert.ok(smsParts(body) <= 2);
  // A typical week is one part.
  assert.equal(smsParts(weekBody(weekParams(WEEK, { '2026-11-16': '10a-5p', '2026-11-18': '10a-6p', '2026-11-21': '9a-3p' }, false))), 1);
});

test('only days still ahead are listed', () => {
  const cells = cellsOf([
    ['a', '2026-11-16', shift(H(9), H(17))],
    ['a', '2026-11-18', shift(H(10), H(18))],
    ['a', '2026-11-20', { shift: null, off: { kind: 'vacation', note: '' } }],
  ]);
  assert.deepEqual(upcomingDays({ weekStart: WEEK, today: '2026-11-10', staffId: 'a', cells }), {
    '2026-11-16': '9a-5p',
    '2026-11-18': '10a-6p',
  });
  assert.deepEqual(upcomingDays({ weekStart: WEEK, today: '2026-11-17', staffId: 'a', cells }), { '2026-11-18': '10a-6p' });
});

test('the first publish texts everyone signed up who works, and says why for the rest', () => {
  const cells = cellsOf([
    ['bj', '2026-11-16', shift(H(10), H(17))],
    ['bj', '2026-11-18', shift(H(10), H(18))],
    ['nikki', '2026-11-21', shift(H(9), H(15))],
    ['staci', '2026-11-17', shift(H(9), H(17))],
    ['jill', '2026-11-19', shift(H(9), H(17))],
  ]);
  const plan = planWeekTexts({
    weekStart: WEEK,
    today: '2026-11-12',
    people: [signedUp('bj'), signedUp('nikki'), { id: 'staci', signup: null }, signedUp('tom'), signedUp('jill', true)],
    cells,
    previous: new Map(),
  });
  const by = Object.fromEntries(plan.map((p) => [p.staffId, p]));
  assert.equal(by.bj.reason, 'first');
  assert.equal(by.bj.body, 'Sunny & Ranney schedule, week of Nov 15: Mon 10a-5p, Wed 10a-6p. Reply STOP to opt out, HELP for help.');
  assert.deepEqual(by.bj.params, { week: 'week of Nov 15', shifts: 'Mon 10a-5p, Wed 10a-6p' });
  assert.equal(by.nikki.reason, 'first');
  assert.equal(by.staci.reason, 'no-number');
  assert.equal(by.tom.reason, 'no-shifts');
  assert.equal(by.jill.reason, 'stopped');
  assert.deepEqual(plan.filter((p) => p.send).map((p) => p.staffId), ['bj', 'nikki']);
});

test('publishing again texts only people whose days ahead changed', () => {
  const before = { bj: { '2026-11-16': '10a-5p', '2026-11-18': '10a-6p' }, nikki: { '2026-11-21': '9a-3p' } };
  const cells = cellsOf([
    ['bj', '2026-11-16', shift(H(10), H(17))],
    ['bj', '2026-11-18', shift(H(12), H(18))],
    ['nikki', '2026-11-21', shift(H(9), H(15))],
  ]);
  const plan = planWeekTexts({
    weekStart: WEEK,
    today: '2026-11-12',
    people: [signedUp('bj'), signedUp('nikki')],
    cells,
    previous: new Map(Object.entries(before)),
  });
  assert.equal(plan[0].reason, 'update');
  assert.equal(plan[0].body, 'Sunny & Ranney schedule, week of Nov 15 (updated): Mon 10a-5p, Wed 12p-6p. Reply STOP to opt out, HELP for help.');
  assert.equal(plan[1].reason, 'unchanged');
  assert.equal(plan[1].send, false);
});

test('fixing a day that has passed texts nobody', () => {
  const before = { bj: { '2026-11-16': '10a-5p', '2026-11-18': '10a-6p' } };
  const cells = cellsOf([
    ['bj', '2026-11-16', shift(H(10), H(15))], // Monday, already past
    ['bj', '2026-11-18', shift(H(10), H(18))],
  ]);
  const [bj] = planWeekTexts({ weekStart: WEEK, today: '2026-11-17', people: [signedUp('bj')], cells, previous: new Map(Object.entries(before)) });
  assert.equal(bj.reason, 'unchanged');
});

test('losing every shift ahead is worth a text', () => {
  const [bj] = planWeekTexts({
    weekStart: WEEK,
    today: '2026-11-12',
    people: [signedUp('bj')],
    cells: new Map(),
    previous: new Map([['bj', { '2026-11-18': '10a-6p' }]]),
  });
  assert.equal(bj.reason, 'update');
  assert.equal(bj.body, 'Sunny & Ranney schedule, week of Nov 15 (updated): no shifts. Reply STOP to opt out, HELP for help.');
});

test('a week that is over texts nobody', () => {
  const cells = cellsOf([['bj', '2026-11-16', shift(H(10), H(17))]]);
  const [bj] = planWeekTexts({ weekStart: WEEK, today: '2026-11-22', people: [signedUp('bj')], cells, previous: new Map() });
  assert.equal(bj.reason, 'past');
});

test('sent.dm statuses map to ours, and STOP reads only as the whole message', () => {
  assert.equal(statusFromSentDm('DELIVERED'), 'delivered');
  assert.equal(statusFromSentDm('read'), 'delivered');
  assert.equal(statusFromSentDm('ROUTED'), 'queued');
  assert.equal(statusFromSentDm('FILTERED'), 'filtered');
  assert.equal(statusFromSentDm('MYSTERY'), null);
  assert.equal(keywordOf(' stop '), 'stop');
  assert.equal(keywordOf('Unstop'), 'start');
  assert.equal(keywordOf('please stop texting'), null);
  assert.equal(statusLabel('filtered', 'BUSINESS_004'), 'Not sent: they replied STOP');
  assert.equal(statusLabel('blocked', 'BUSINESS_003'), 'Not sent: the sent.dm balance is too low');
});
