/**
 * The week's special, kept in D1
 * ===========================================================================
 * One row per Tuesday email: the special as Staci saved it (only its kind's fields),
 * who saved it and when. The admin page reads and writes it; the weekly build reads it
 * (scripts/sunny-side/build.mjs). Saving checks the version the page loaded, so two
 * managers can't overwrite each other without knowing.
 */

import { clean } from './special.mjs';

export const SCHEMA = `CREATE TABLE IF NOT EXISTS email_specials (
  send_date TEXT PRIMARY KEY, special TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`;

const _ready = new WeakSet();
/** Makes the table on first use. Nothing to migrate by hand. */
export async function ensureTable(db) {
  if (_ready.has(db)) return;
  await db.prepare(SCHEMA).run();
  _ready.add(db);
}

const fromRow = (r) => ({ send: r.send_date, special: clean(JSON.parse(r.special)), updatedAt: r.updated_at, updatedBy: r.updated_by });

/** The special for one email, or null. */
export async function getSpecial(db, send) {
  await ensureTable(db);
  const r = await db.prepare('SELECT * FROM email_specials WHERE send_date = ?').bind(send).first();
  return r ? fromRow(r) : null;
}

/** Every special from one send date to another, inclusive, oldest first. */
export async function specialsBetween(db, from, to) {
  await ensureTable(db);
  const { results } = await db.prepare('SELECT * FROM email_specials WHERE send_date BETWEEN ? AND ? ORDER BY send_date').bind(from, to).all();
  return (results || []).map(fromRow);
}

/** The most recent specials before a send date, newest first: the ones Staci can start from. */
export async function pastSpecials(db, before, limit = 12) {
  await ensureTable(db);
  const { results } = await db.prepare('SELECT * FROM email_specials WHERE send_date < ? ORDER BY send_date DESC LIMIT ?').bind(before, limit).all();
  return (results || []).map(fromRow);
}

/**
 * Saves a checked special. `since` is the updatedAt the page loaded (null for a week with
 * no special yet); if someone saved in between, nothing changes and the newer one comes back.
 */
export async function putSpecial(db, { send, special, by, now, since }) {
  await ensureTable(db);
  const json = JSON.stringify(special);
  const result =
    since === null
      ? await db
          .prepare('INSERT INTO email_specials (send_date, special, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(send_date) DO NOTHING')
          .bind(send, json, now, by)
          .run()
      : await db
          .prepare('UPDATE email_specials SET special = ?, updated_at = ?, updated_by = ? WHERE send_date = ? AND updated_at = ?')
          .bind(json, now, by, send, since)
          .run();
  if (result.meta.changes === 1) return { ok: true, record: { send, special, updatedAt: now, updatedBy: by } };
  return { ok: false, current: await getSpecial(db, send) };
}

/** Takes a week's special away, if it's still the version the page loaded. */
export async function clearSpecial(db, { send, since }) {
  await ensureTable(db);
  const result = await db.prepare('DELETE FROM email_specials WHERE send_date = ? AND updated_at = ?').bind(send, since).run();
  if (result.meta.changes === 1) return { ok: true };
  return { ok: false, current: await getSpecial(db, send) };
}
