import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptToken, encryptToken } from './tokens.mjs';

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

test('a token survives a round trip, and never appears in the stored value', async () => {
  const sealed = await encryptToken('secret-token', key);
  assert.ok(!sealed.includes('secret-token'));
  assert.equal(await decryptToken(sealed, key), 'secret-token');
});

test('encrypting twice gives different values', async () => {
  assert.notEqual(await encryptToken('same', key), await encryptToken('same', key));
});

test('a tampered value or the wrong key fails instead of returning junk', async () => {
  const sealed = await encryptToken('secret-token', key);
  const [version, iv, data] = sealed.split('.');
  const flipped = `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`;
  await assert.rejects(decryptToken([version, iv, flipped].join('.'), key));
  await assert.rejects(decryptToken(sealed, otherKey));
  await assert.rejects(decryptToken('not-a-token', key));
});

test('a missing or short key is refused', async () => {
  await assert.rejects(encryptToken('x', ''), /32 random bytes/);
  await assert.rejects(encryptToken('x', btoa('short')), /32 random bytes/);
  await assert.rejects(encryptToken('x', undefined), /32 random bytes/);
});
