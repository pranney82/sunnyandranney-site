import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMinutes, parseTypedTime } from './time-input.mjs';

const at = (h, m = 0) => h * 60 + m;

test('am and pm, with and without minutes and colons', () => {
  const near = at(12);
  assert.equal(parseTypedTime('5p', near), at(17));
  assert.equal(parseTypedTime('5pm', near), at(17));
  assert.equal(parseTypedTime('5:30 PM', near), at(17, 30));
  assert.equal(parseTypedTime('530p', near), at(17, 30));
  assert.equal(parseTypedTime('9a', near), at(9));
  assert.equal(parseTypedTime('9.15am', near), at(9, 15));
  assert.equal(parseTypedTime('12p', near), at(12));
  assert.equal(parseTypedTime('12a', near), at(0));
  assert.equal(parseTypedTime('noon', near), at(12));
});

test('24-hour times', () => {
  assert.equal(parseTypedTime('17:30', 0), at(17, 30));
  assert.equal(parseTypedTime('1730', 0), at(17, 30));
  assert.equal(parseTypedTime('0:45', at(12)), at(0, 45));
});

test('no am or pm: the nearer of morning and afternoon', () => {
  // Over a 9:12 PM clock-out, "5" means 5 PM.
  assert.equal(parseTypedTime('5', at(21, 12)), at(17));
  // Over a 9:58 AM clock-in, "9" means 9 AM.
  assert.equal(parseTypedTime('9', at(9, 58)), at(9));
  assert.equal(parseTypedTime('6:30', at(18)), at(18, 30));
});

test('nonsense is refused rather than guessed', () => {
  for (const text of ['', 'abc', '25:00', '5:75', '13p', '0a', '12345', '5::30']) {
    assert.equal(parseTypedTime(text, at(12)), null, text);
  }
});

test('formatMinutes', () => {
  assert.equal(formatMinutes(at(17, 5)), '5:05 PM');
  assert.equal(formatMinutes(at(0)), '12:00 AM');
  assert.equal(formatMinutes(at(12)), '12:00 PM');
});
