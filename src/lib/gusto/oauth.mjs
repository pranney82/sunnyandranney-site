/**
 * Gusto's OAuth2 flow. GUSTO_ENV must name the environment outright: anything
 * else leaves the integration switched off, so a missing setting can never fall
 * through to production.
 *
 * There are two routes. `mcp` is Gusto's server for customers connecting their
 * own company, and is read-only here. `api` is the partner API, which needs
 * Gusto's approval. MCP client settings take priority when both are present.
 */
import { MCP_HOSTS, MCP_SCOPES } from './mcp-oauth.mjs';

export const GUSTO_API_VERSION = '2026-06-15';
export const CALLBACK_PATH = '/api/admin/gusto/callback/';

const HOSTS = {
  demo: 'https://api.gusto-demo.com',
  production: 'https://api.gusto.com',
};
const REQUEST_TIMEOUT_MS = 15_000;
// Gusto's advice: treat tokens as expired a minute early.
const EXPIRY_MARGIN_SECONDS = 60;

/**
 * `definite` means Gusto refused the request, so it had no effect. When false,
 * the request may have gone through, which matters when sending hours.
 */
export class GustoError extends Error {
  constructor(message, { status = 0, code = '', definite = false } = {}) {
    super(message);
    this.name = 'GustoError';
    this.status = status;
    this.code = code;
    this.definite = definite;
  }
}

/** @returns the settings, or null if any are missing */
export function gustoConfig(env) {
  const { GUSTO_ENV: environment, GUSTO_TOKEN_KEY: tokenKey } = env;
  if (!tokenKey || !Object.hasOwn(HOSTS, environment ?? '')) return null;

  const { GUSTO_MCP_CLIENT_ID: mcpId, GUSTO_MCP_CLIENT_SECRET: mcpSecret } = env;
  if (mcpId && mcpSecret) {
    return { route: 'mcp', environment, base: MCP_HOSTS[environment], clientId: mcpId, clientSecret: mcpSecret, tokenKey };
  }
  const { GUSTO_CLIENT_ID: clientId, GUSTO_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) return null;
  return { route: 'api', environment, base: HOSTS[environment], clientId, clientSecret, tokenKey };
}

export function redirectUriFor(origin) {
  return `${origin}${CALLBACK_PATH}`;
}

export function authorizeUrl(config, { state, redirectUri, codeChallenge }) {
  const url = new URL('/oauth/authorize', config.base);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    ...(config.route === 'mcp'
      ? { scope: MCP_SCOPES, code_challenge: codeChallenge, code_challenge_method: 'S256', resource: `${config.base}/` }
      : {}),
  }).toString();
  return url.toString();
}

export function tokenSetFrom(body, now = Date.now()) {
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, scope } = body ?? {};
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !Number.isFinite(expiresIn)) {
    throw new GustoError('Gusto sent an unreadable token response.');
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: now + (expiresIn - EXPIRY_MARGIN_SECONDS) * 1000,
    scopes: typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [],
  };
}

/** The partner API takes JSON. The MCP server follows the OAuth standard and takes a form. */
function oauthBody(config, fields) {
  const all = { client_id: config.clientId, client_secret: config.clientSecret, ...fields };
  return config.route === 'mcp'
    ? { type: 'application/x-www-form-urlencoded', body: new URLSearchParams(all).toString() }
    : { type: 'application/json', body: JSON.stringify(all) };
}

async function tokenRequest(config, grant, fetchImpl) {
  const { type, body: requestBody } = oauthBody(config, grant);
  let res;
  try {
    res = await fetchImpl(`${config.base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': type, Accept: 'application/json' },
      body: requestBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GustoError('Could not reach Gusto.');
  }
  const body = await res.json().catch(() => null);
  if (res.ok) return tokenSetFrom(body);
  throw new GustoError('Gusto refused the sign-in.', {
    status: res.status,
    code: typeof body?.error === 'string' ? body.error : '',
    definite: res.status < 500,
  });
}

export function exchangeCode(config, { code, redirectUri, codeVerifier }, fetchImpl = fetch) {
  return tokenRequest(
    config,
    {
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    },
    fetchImpl,
  );
}

export function refreshGrant(config, { refreshToken, redirectUri }, fetchImpl = fetch) {
  return tokenRequest(
    config,
    { refresh_token: refreshToken, redirect_uri: redirectUri, grant_type: 'refresh_token' },
    fetchImpl,
  );
}

/** Best effort: the local tokens are deleted whether or not this works. */
/**
 * Asks Gusto to cancel a sign-in. Gusto's MCP server refuses this for every
 * client but its own (403 unauthorized_client), so callers must tell the owner
 * to finish in Gusto whenever this returns false.
 *
 * @returns true only when Gusto accepted the request
 */
export async function revokeToken(config, token, fetchImpl = fetch) {
  const { type, body } = oauthBody(config, { token });
  try {
    const res = await fetchImpl(`${config.base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': type, Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
