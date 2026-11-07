import assert from 'node:assert/strict';
import test from 'node:test';
import { createGustoClient } from './client.mjs';
import { GustoError } from './oauth.mjs';

const reply = (status, body) => new Response(JSON.stringify(body), { status });

function clientWith(handler, getToken = async () => 'tok') {
  const calls = [];
  const client = createGustoClient({
    base: 'https://api.gusto-demo.com',
    companyUuid: 'co',
    getToken,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return handler(calls.length, new URL(url), init);
    },
  });
  return { client, calls };
}

test('sends the token and pins the API version', async () => {
  const { client, calls } = clientWith(() => reply(200, { ok: true }));
  await client.get(client.companyPath('employees'), { a: 1 });
  assert.equal(calls[0].url.pathname, '/v1/companies/co/employees');
  assert.equal(calls[0].url.searchParams.get('a'), '1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers['X-Gusto-API-Version'], '2026-06-15');
});

test('getPaged reads until a short page', async () => {
  const { client, calls } = clientWith((n) => reply(200, Array.from({ length: n < 3 ? 100 : 7 }, (_, i) => ({ i }))));
  const rows = await client.getPaged('/v1/x', { q: 'y' });
  assert.equal(rows.length, 207);
  assert.deepEqual(calls.map((call) => call.url.searchParams.get('page')), ['1', '2', '3']);
  assert.equal(calls[0].url.searchParams.get('per'), '100');
});

test('getPaged stops rather than return a cut-off list', async () => {
  const { client } = clientWith(() => reply(200, Array.from({ length: 100 }, () => ({}))));
  await assert.rejects(client.getPaged('/v1/x'), /too long/);
  const notList = clientWith(() => reply(200, { surprise: true }));
  await assert.rejects(notList.client.getPaged('/v1/x'), /unreadable/);
});

test('a 401 gets one new token and one retry', async () => {
  const seen = [];
  const { client, calls } = clientWith(
    (n) => (n === 1 ? reply(401, {}) : reply(200, { ok: 1 })),
    async (options) => {
      seen.push(options?.rejected);
      return options?.rejected ? 'fresh' : 'stale';
    },
  );
  assert.deepEqual(await client.get('/v1/x'), { ok: 1 });
  assert.deepEqual(seen, [undefined, 'stale']);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer fresh');

  const always = clientWith(() => reply(401, {}));
  await assert.rejects(always.client.get('/v1/x'), (err) => err.status === 401);
  assert.equal(always.calls.length, 2);
});

test('a refusal is definite, a server error or lost connection is not', async () => {
  const refused = clientWith(() => reply(422, { errors: [{ message: 'Entries are invalid' }] }));
  await assert.rejects(refused.client.post('/v1/x', {}), (err) => err.definite && err.message === 'Entries are invalid');
  const broken = clientWith(() => reply(502, {}));
  await assert.rejects(broken.client.post('/v1/x', {}), (err) => !err.definite);
  const offline = clientWith(() => { throw new Error('connection reset'); });
  await assert.rejects(offline.client.post('/v1/x', {}), (err) => err instanceof GustoError && !err.definite);
});
