import assert from 'node:assert/strict';
import test from 'node:test';
import { removeConnection } from './connection.mjs';
import { gustoConfig, revokeToken } from './oauth.mjs';
import { encryptToken } from './tokens.mjs';

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const config = gustoConfig({
  GUSTO_ENV: 'demo',
  GUSTO_TOKEN_KEY: key,
  GUSTO_MCP_CLIENT_ID: 'mcp-id',
  GUSTO_MCP_CLIENT_SECRET: 'mcp-secret',
});

/** Just enough of D1 for removeConnection: one row, read and deleted. */
function fakeDb(row) {
  const db = {
    row,
    prepare(sql) {
      return {
        first: async () => db.row,
        run: async () => {
          if (sql.startsWith('DELETE')) db.row = null;
        },
      };
    },
  };
  return db;
}

// What Gusto's MCP server answers when any client but its own asks to revoke.
const refused = async () =>
  new Response(JSON.stringify({ error: 'unauthorized_client', error_description: 'You are not authorized to revoke this token' }), { status: 403 });

test('revokeToken is true only when Gusto accepts', async () => {
  let sent;
  const accepted = async (url, init) => {
    sent = { url, body: new URLSearchParams(init.body) };
    return new Response('{}', { status: 200 });
  };
  assert.equal(await revokeToken(config, 'r', accepted), true);
  assert.equal(sent.url, 'https://mcp.api.gusto-demo.com/oauth/revoke');
  assert.equal(sent.body.get('token'), 'r');
  assert.equal(await revokeToken(config, 'r', refused), false);
  assert.equal(await revokeToken(config, 'r', async () => new Response('', { status: 500 })), false);
  assert.equal(await revokeToken(config, 'r', async () => { throw new Error('down'); }), false);
});

test('Disconnect deletes the stored sign-in even when Gusto refuses to cancel it, and says so', async () => {
  const db = fakeDb({ refresh_token: await encryptToken('refresh', key) });
  assert.deepEqual(await removeConnection(db, config, refused), { revoked: false });
  assert.equal(db.row, null);
});

test('Disconnect reports a cancel Gusto confirmed', async () => {
  const db = fakeDb({ refresh_token: await encryptToken('refresh', key) });
  assert.deepEqual(await removeConnection(db, config, async () => new Response('{}')), { revoked: true });
  assert.equal(db.row, null);
});

test('Disconnect still deletes a sign-in it cannot decrypt, and never claims it was cancelled', async () => {
  const db = fakeDb({ refresh_token: await encryptToken('refresh', otherKey) });
  let asked = false;
  const result = await removeConnection(db, config, async () => {
    asked = true;
    return new Response('{}');
  });
  assert.deepEqual(result, { revoked: false });
  assert.equal(asked, false);
  assert.equal(db.row, null);
});

test('Disconnect with nothing connected changes nothing', async () => {
  const db = fakeDb(null);
  assert.deepEqual(await removeConnection(db, config, async () => new Response('{}')), { revoked: false });
});
