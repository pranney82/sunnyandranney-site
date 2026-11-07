import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPin, verifyPin } from './pin.mjs';

test('a PIN verifies against its own hash only', async () => {
  const { salt, hash } = await hashPin('4821');
  assert.equal(await verifyPin('4821', salt, hash), true);
  assert.equal(await verifyPin('4822', salt, hash), false);
});

test('the same PIN hashes differently per person', async () => {
  const a = await hashPin('4821');
  const b = await hashPin('4821');
  assert.notEqual(a.hash, b.hash);
});

test('malformed PINs and unset hashes fail', async () => {
  const { salt, hash } = await hashPin('4821');
  assert.equal(await verifyPin('12', salt, hash), false);
  assert.equal(await verifyPin(4821, salt, hash), false);
  assert.equal(await verifyPin('4821', null, null), false);
});
