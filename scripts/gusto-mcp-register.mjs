#!/usr/bin/env node
/**
 * Registers the store admin as a client of Gusto's MCP server. The secret is
 * never printed: demo goes to .dev.vars, and production to .dev.vars.production,
 * so a production client can't end up in local testing by accident.
 *
 *   node scripts/gusto-mcp-register.mjs demo http://localhost:8789
 *
 * Gusto ignores the requested permissions and ticks every box on its sign-in
 * screen, so the owner has to untick them. See "Gusto connection" in the README.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MCP_HOSTS, MCP_SCOPES } from '../src/lib/gusto/mcp-oauth.mjs';
import { CALLBACK_PATH } from '../src/lib/gusto/oauth.mjs';

const [environment, ...origins] = process.argv.slice(2);
const host = MCP_HOSTS[environment];
if (!host || origins.length === 0) {
  console.error('Usage: node scripts/gusto-mcp-register.mjs <demo|production> <site origin> [more origins]');
  process.exit(1);
}

const res = await fetch(`${host}/oauth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    client_name: 'Sunny & Ranney Store Admin',
    redirect_uris: origins.map((origin) => `${origin.replace(/\/$/, '')}${CALLBACK_PATH}`),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    scope: MCP_SCOPES,
  }),
  signal: AbortSignal.timeout(15_000),
});
const body = await res.json().catch(() => null);
if (!res.ok || !body?.client_id) {
  console.error(`Gusto refused the registration (HTTP ${res.status}).`, JSON.stringify(body)?.slice(0, 400));
  process.exit(1);
}

const file = new URL(environment === 'production' ? '../.dev.vars.production' : '../.dev.vars', import.meta.url);
const kept = existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter((line) => !/^GUSTO_MCP_CLIENT_(ID|SECRET)=/.test(line))
  : [];
while (kept.at(-1) === '') kept.pop();
kept.push(`GUSTO_MCP_CLIENT_ID=${body.client_id}`);
if (body.client_secret) kept.push(`GUSTO_MCP_CLIENT_SECRET=${body.client_secret}`);
writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
chmodSync(file, 0o600);

const { client_secret: _secret, client_id: _id, ...rest } = body;
console.log(`Registered. Saved to ${file.pathname.split('/').pop()}. Gusto answered with:`, JSON.stringify({ ...rest, client_secret: body.client_secret ? '(saved)' : '(none)' }));
