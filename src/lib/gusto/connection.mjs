/** The stored connection to Gusto, and the access token that goes with it. */
import { GustoError, refreshGrant, revokeToken } from './oauth.mjs';
import { decryptToken, encryptToken } from './tokens.mjs';

const LOCK_MS = 30_000;
const POLL_MS = 300;
const POLL_TRIES = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readRow = (db) => db.prepare('SELECT * FROM gusto_connection WHERE id = 1').first();

/** Everything about the connection except the tokens. */
export function connectionStatus(db) {
  return db
    .prepare(
      `SELECT environment, company_uuid, company_name, connected_by, connected_at, needs_reconnect, employees_synced_at, scopes
       FROM gusto_connection WHERE id = 1`,
    )
    .first();
}

export async function saveConnection(db, config, { tokens, companyUuid, companyName, scopes, redirectUri, actor }) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO gusto_connection
         (id, environment, company_uuid, company_name, redirect_uri, access_token, refresh_token, expires_at,
          connected_by, connected_at, updated_at, scopes)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         environment = excluded.environment, company_uuid = excluded.company_uuid, company_name = excluded.company_name,
         redirect_uri = excluded.redirect_uri, access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, refresh_lock_until = 0,
         needs_reconnect = 0, employees_synced_at = NULL, connected_by = excluded.connected_by,
         connected_at = excluded.connected_at, updated_at = excluded.updated_at, scopes = excluded.scopes`,
    )
    .bind(
      config.environment,
      companyUuid,
      companyName,
      redirectUri,
      await encryptToken(tokens.accessToken, config.tokenKey),
      await encryptToken(tokens.refreshToken, config.tokenKey),
      tokens.expiresAt,
      actor,
      now,
      now,
      Array.isArray(scopes) ? scopes.join(' ') : null,
    )
    .run();
}

/**
 * Deletes the stored sign-in, then asks Gusto to cancel it.
 *
 * @returns `revoked` is true only if Gusto confirmed the cancel. When it is
 *   false, the sign-in still works at Gusto until someone removes it there.
 */
export async function removeConnection(db, config, fetchImpl = fetch) {
  const row = await readRow(db);
  if (!row) return { revoked: false };
  await db.prepare('DELETE FROM gusto_connection WHERE id = 1').run();
  let refreshToken;
  try {
    refreshToken = await decryptToken(row.refresh_token, config.tokenKey);
  } catch {
    return { revoked: false };
  }
  return { revoked: await revokeToken(config, refreshToken, fetchImpl) };
}

async function refreshConnection(db, config, row, fetchImpl) {
  try {
    const tokens = await refreshGrant(
      config,
      { refreshToken: await decryptToken(row.refresh_token, config.tokenKey), redirectUri: row.redirect_uri },
      fetchImpl,
    );
    await db
      .prepare(
        `UPDATE gusto_connection SET access_token = ?, refresh_token = ?, expires_at = ?, refresh_lock_until = 0,
           updated_at = ? WHERE id = 1`,
      )
      .bind(
        await encryptToken(tokens.accessToken, config.tokenKey),
        await encryptToken(tokens.refreshToken, config.tokenKey),
        tokens.expiresAt,
        new Date().toISOString(),
      )
      .run();
    return tokens.accessToken;
  } catch (err) {
    // invalid_grant means the refresh token is dead, and only signing in again fixes that.
    const dead = err instanceof GustoError && err.code === 'invalid_grant';
    await db
      .prepare('UPDATE gusto_connection SET refresh_lock_until = 0, needs_reconnect = ? WHERE id = 1')
      .bind(dead ? 1 : 0)
      .run();
    throw err;
  }
}

/**
 * A current access token, refreshing it if needed. Pass `rejected` when Gusto
 * answered 401 to a token that looked valid. Refresh tokens work once, so only
 * the request that wins the lock refreshes; the rest wait for its result.
 */
export async function accessToken(db, config, { rejected, fetchImpl = fetch } = {}) {
  for (let attempt = 0; attempt < POLL_TRIES; attempt++) {
    const row = await readRow(db);
    if (!row) throw new GustoError('Gusto is not connected.', { definite: true });
    if (row.needs_reconnect) throw new GustoError('Gusto needs to be reconnected.', { definite: true });
    if (row.environment !== config.environment) {
      throw new GustoError('Gusto is connected to a different environment.', { definite: true });
    }

    const current = await decryptToken(row.access_token, config.tokenKey);
    const usable = rejected ? current !== rejected : Date.now() < row.expires_at;
    if (usable) return current;

    const now = Date.now();
    const { meta } = await db
      .prepare('UPDATE gusto_connection SET refresh_lock_until = ? WHERE id = 1 AND refresh_lock_until <= ?')
      .bind(now + LOCK_MS, now)
      .run();
    if (meta.changes === 1) return refreshConnection(db, config, row, fetchImpl);
    await sleep(POLL_MS);
  }
  throw new GustoError('Gusto sign-in is busy. Try again in a moment.');
}
