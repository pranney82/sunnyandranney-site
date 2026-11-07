/** Calls Gusto's API for the connected company. */
import { accessToken, connectionStatus } from './connection.mjs';
import { createMcpClient } from './mcp-client.mjs';
import { canFillPayroll, canSendHours } from './mcp-oauth.mjs';
import { GUSTO_API_VERSION, GustoError, gustoConfig } from './oauth.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function errorMessage(body, status) {
  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  return first?.message ?? (typeof body?.message === 'string' ? body.message : `Gusto answered ${status}.`);
}

export function createGustoClient({ base, companyUuid, getToken, fetchImpl = fetch }) {
  async function send(method, path, query, body, token) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    return fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'X-Gusto-API-Version': GUSTO_API_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function request(method, path, { query, body } = {}) {
    let res;
    try {
      const token = await getToken();
      res = await send(method, path, query, body, token);
      // Gusto can revoke a token early, so one 401 earns one fresh token.
      if (res.status === 401) res = await send(method, path, query, body, await getToken({ rejected: token }));
    } catch (err) {
      if (err instanceof GustoError) throw err;
      throw new GustoError('Could not reach Gusto.');
    }
    const parsed = await res.json().catch(() => null);
    if (res.ok) return parsed;
    throw new GustoError(errorMessage(parsed, res.status), { status: res.status, definite: res.status < 500 });
  }

  /** Every page of a list, so a long list can't come back silently cut off. */
  async function getPaged(path, query = {}) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await request('GET', path, { query: { ...query, page, per: PAGE_SIZE } });
      if (!Array.isArray(batch)) throw new GustoError('Gusto sent an unreadable list.');
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return rows;
    }
    throw new GustoError('That list is too long to read at once. Narrow the dates.');
  }

  const companyPath = (suffix = '') => `/v1/companies/${encodeURIComponent(companyUuid)}${suffix ? `/${suffix}` : ''}`;

  return {
    companyUuid,
    route: 'api',
    // This route puts hours on payroll with its own sync, not by setting them.
    fillsPayroll: false,
    readOnly: false,
    companyPath,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    getPaged,
    listEmployees: () => getPaged(companyPath('employees')),
    listPayrolls: (query) => getPaged(companyPath('payrolls'), query),
    getPayroll: (uuid) => request('GET', companyPath(`payrolls/${encodeURIComponent(uuid)}`)),
  };
}

/**
 * Where the connection stands, with a client when it's usable. Pages check
 * `state`, so a Gusto problem shows as a message and never stops the admin.
 */
export async function liveGusto(env) {
  const config = gustoConfig(env);
  if (!config) return { state: 'unconfigured' };
  const db = env.DB;
  const connection = await connectionStatus(db);
  if (!connection) return { state: 'disconnected', config };
  if (connection.needs_reconnect || connection.environment !== config.environment) {
    return { state: 'reconnect', config, connection };
  }
  const create = config.route === 'mcp' ? createMcpClient : createGustoClient;
  const client = create({
    base: config.base,
    companyUuid: connection.company_uuid,
    getToken: (options) => accessToken(db, config, options),
    sendsHours: canSendHours((connection.scopes ?? '').split(' ')),
    fillsPayroll: canFillPayroll((connection.scopes ?? '').split(' ')),
  });
  return { state: 'ready', config, connection, client, readOnly: client.readOnly };
}
