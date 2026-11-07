import assert from 'node:assert/strict';
import test from 'node:test';
import { GustoError, authorizeUrl, exchangeCode, gustoConfig, redirectUriFor, refreshGrant, tokenSetFrom } from './oauth.mjs';

const env = { GUSTO_ENV: 'demo', GUSTO_CLIENT_ID: 'id', GUSTO_CLIENT_SECRET: 'secret', GUSTO_TOKEN_KEY: 'key' };
const respond = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('gustoConfig needs every setting and an environment named outright', () => {
  assert.equal(gustoConfig(env).base, 'https://api.gusto-demo.com');
  assert.equal(gustoConfig({ ...env, GUSTO_ENV: 'production' }).base, 'https://api.gusto.com');
  assert.equal(gustoConfig({ ...env, GUSTO_ENV: undefined }), null);
  assert.equal(gustoConfig({ ...env, GUSTO_ENV: 'prod' }), null);
  for (const key of ['GUSTO_CLIENT_ID', 'GUSTO_CLIENT_SECRET', 'GUSTO_TOKEN_KEY']) {
    assert.equal(gustoConfig({ ...env, [key]: '' }), null);
  }
});

test('authorizeUrl carries what Gusto requires, and never the secret', () => {
  const url = new URL(authorizeUrl(gustoConfig(env), { state: 'abc', redirectUri: redirectUriFor('https://sunnyandranney.com') }));
  assert.equal(url.origin + url.pathname, 'https://api.gusto-demo.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'id');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'abc');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://sunnyandranney.com/api/admin/gusto/callback/');
  assert.ok(!url.toString().includes('secret'));
});

test('tokenSetFrom counts expiry a minute early and rejects a bad response', () => {
  const set = tokenSetFrom({ access_token: 'a', refresh_token: 'r', expires_in: 7200 }, 1000);
  assert.equal(set.expiresAt, 1000 + 7140 * 1000);
  assert.throws(() => tokenSetFrom({ access_token: 'a' }), GustoError);
  assert.throws(() => tokenSetFrom(null), GustoError);
});

test('exchangeCode sends the grant in the body', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 7200 }));
  };
  const set = await exchangeCode(gustoConfig(env), { code: 'c', redirectUri: 'https://x/cb/' }, fetchImpl);
  assert.equal(set.accessToken, 'a');
  assert.equal(sent.url, 'https://api.gusto-demo.com/oauth/token');
  assert.deepEqual(sent.body, { client_id: 'id', client_secret: 'secret', code: 'c', redirect_uri: 'https://x/cb/', grant_type: 'authorization_code' });
});

test('refreshGrant reports a dead token by its code, and a server error as not definite', async () => {
  await assert.rejects(refreshGrant(gustoConfig(env), { refreshToken: 'r', redirectUri: 'u' }, respond(400, { error: 'invalid_grant' })), (err) => err.code === 'invalid_grant' && err.definite);
  await assert.rejects(refreshGrant(gustoConfig(env), { refreshToken: 'r', redirectUri: 'u' }, respond(503, {})), (err) => err.status === 503 && !err.definite);
  await assert.rejects(refreshGrant(gustoConfig(env), { refreshToken: 'r', redirectUri: 'u' }, async () => { throw new Error('down'); }), (err) => err instanceof GustoError && !err.definite);
});

const mcpEnv = { ...env, GUSTO_MCP_CLIENT_ID: 'mcp-id', GUSTO_MCP_CLIENT_SECRET: 'mcp-secret' };

test('MCP settings choose the MCP route, for the environment named', () => {
  assert.equal(gustoConfig(env).route, 'api');
  const config = gustoConfig(mcpEnv);
  assert.equal(config.route, 'mcp');
  assert.equal(config.base, 'https://mcp.api.gusto-demo.com');
  assert.equal(config.clientId, 'mcp-id');
  assert.equal(gustoConfig({ ...mcpEnv, GUSTO_ENV: 'production' }).base, 'https://mcp.api.gusto.com');
  assert.equal(gustoConfig({ ...mcpEnv, GUSTO_ENV: 'prod' }), null);
  assert.equal(gustoConfig({ ...mcpEnv, GUSTO_ENV: undefined }), null);
  assert.equal(gustoConfig({ ...mcpEnv, GUSTO_TOKEN_KEY: '' }), null);
});

test('the MCP sign-in link asks for read access plus the two writes the admin uses, and carries the PKCE challenge', () => {
  const url = new URL(authorizeUrl(gustoConfig(mcpEnv), { state: 'abc', redirectUri: 'https://x/cb', codeChallenge: 'chal' }));
  assert.equal(url.origin, 'https://mcp.api.gusto-demo.com');
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  for (const scope of url.searchParams.get('scope').split(' ')) assert.ok(/:read$/.test(scope) || ['time_sheet:write', 'payrolls:write'].includes(scope), scope);
  assert.ok(!url.toString().includes('mcp-secret'));
});

test('the MCP route sends tokens requests as a form, with the PKCE verifier', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, type: init.headers['Content-Type'], body: new URLSearchParams(init.body) };
    return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 7200, scope: 'a:read b:read' }));
  };
  const tokens = await exchangeCode(gustoConfig(mcpEnv), { code: 'c', redirectUri: 'https://x/cb', codeVerifier: 'v' }, fetchImpl);
  assert.equal(sent.url, 'https://mcp.api.gusto-demo.com/oauth/token');
  assert.equal(sent.type, 'application/x-www-form-urlencoded');
  assert.equal(sent.body.get('code_verifier'), 'v');
  assert.equal(sent.body.get('client_secret'), 'mcp-secret');
  assert.deepEqual(tokens.scopes, ['a:read', 'b:read']);
});
