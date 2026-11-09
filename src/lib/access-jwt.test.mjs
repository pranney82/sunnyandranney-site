import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyAccessJwt } from './access-jwt.mjs';

const teamDomain = 'store.cloudflareaccess.com';
const audience = 'aud-123';
const now = 1_800_000_000;
const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
  return { kid, privateKey: pair.privateKey, publicJwk };
}

const b64 = (value) => Buffer.from(value).toString('base64url');

async function sign(key, claims, header = {}) {
  const head = b64(JSON.stringify({ alg: 'RS256', kid: key.kid, ...header }));
  const body = b64(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(algorithm, key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(signature))}`;
}

const goodClaims = {
  iss: `https://${teamDomain}`,
  aud: [audience],
  email: 'Staci@Example.com',
  exp: now + 60,
  nbf: now - 60,
};

const trusted = await makeKey('trusted');
const attacker = await makeKey('attacker');
const options = { teamDomain, audience, nowSeconds: now, getKeys: async () => [trusted.publicJwk] };

test('accepts a valid token and lowercases the email', async () => {
  assert.deepEqual(await verifyAccessJwt(await sign(trusted, goodClaims), options), { email: 'staci@example.com' });
});

test('accepts aud given as a plain string', async () => {
  const token = await sign(trusted, { ...goodClaims, aud: audience });
  assert.notEqual(await verifyAccessJwt(token, options), null);
});

test('rejects a missing or malformed token', async () => {
  for (const token of [null, '', 'abc', 'a.b.c', 'a.b']) {
    assert.equal(await verifyAccessJwt(token, options), null);
  }
});

test('rejects a token signed by another key using a trusted kid', async () => {
  const forged = await sign({ ...attacker, kid: 'trusted' }, goodClaims);
  assert.equal(await verifyAccessJwt(forged, options), null);
});

test('rejects an unknown kid', async () => {
  assert.equal(await verifyAccessJwt(await sign(attacker, goodClaims), options), null);
});

test('rejects tampered claims', async () => {
  const [head, , signature] = (await sign(trusted, goodClaims)).split('.');
  const body = b64(JSON.stringify({ ...goodClaims, email: 'owner@example.com' }));
  assert.equal(await verifyAccessJwt(`${head}.${body}.${signature}`, options), null);
});

test('rejects alg none and HS256', async () => {
  const body = b64(JSON.stringify(goodClaims));
  const none = `${b64(JSON.stringify({ alg: 'none', kid: 'trusted' }))}.${body}.`;
  assert.equal(await verifyAccessJwt(none, options), null);
  assert.equal(await verifyAccessJwt(await sign(trusted, goodClaims, { alg: 'HS256' }), options), null);
});

test('rejects wrong issuer or audience', async () => {
  assert.equal(await verifyAccessJwt(await sign(trusted, { ...goodClaims, iss: 'https://evil.example' }), options), null);
  assert.equal(await verifyAccessJwt(await sign(trusted, { ...goodClaims, aud: ['other'] }), options), null);
});

test('rejects expired, not-yet-valid, and exp-less tokens', async () => {
  assert.equal(await verifyAccessJwt(await sign(trusted, { ...goodClaims, exp: now }), options), null);
  assert.equal(await verifyAccessJwt(await sign(trusted, { ...goodClaims, nbf: now + 5 }), options), null);
  const { exp: _exp, ...noExp } = goodClaims;
  assert.equal(await verifyAccessJwt(await sign(trusted, noExp), options), null);
});

test('rejects a token with neither an email nor a service token ID', async () => {
  const { email: _email, ...noEmail } = goodClaims;
  assert.equal(await verifyAccessJwt(await sign(trusted, noEmail), options), null);
});

test('names a service token by its client ID, and never as a person', async () => {
  const { email: _email, ...noEmail } = goodClaims;
  const token = await sign(trusted, { ...noEmail, common_name: 'register-1.access' });
  assert.deepEqual(await verifyAccessJwt(token, options), { serviceToken: 'register-1.access' });
  // A forged service token fails the signature like anything else.
  assert.equal(await verifyAccessJwt(await sign(attacker, { ...noEmail, common_name: 'register-1.access' }), options), null);
});

test('fails closed when unconfigured or when keys cannot be fetched', async () => {
  const token = await sign(trusted, goodClaims);
  assert.equal(await verifyAccessJwt(token, { ...options, audience: '' }), null);
  assert.equal(await verifyAccessJwt(token, { ...options, teamDomain: '' }), null);
  const failing = { ...options, getKeys: async () => { throw new Error('network'); } };
  assert.equal(await verifyAccessJwt(token, failing), null);
});
