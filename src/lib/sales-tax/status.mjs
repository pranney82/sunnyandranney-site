/**
 * Each month's sales tax: where it stands, and the filing record
 * ===========================================================================
 * D1 table sales_tax_months, one row a month. The sales-tax worker (run.mjs)
 * writes the send: tries, the email's id, the figures, the PDF and the
 * spreadsheet. The admin writes the rest: when the filing page was first
 * opened, and who marked the month filed with which Georgia Tax Center
 * confirmation number. Kept apart from run.mjs so the admin doesn't bundle
 * the PDF library.
 */

import { SEND_HOUR_ET, dueDate, dueMonth, eastern, monthName } from './figures.mjs';

export const SCHEMA = `CREATE TABLE IF NOT EXISTS sales_tax_months (
  month TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'trying', tries INTEGER NOT NULL DEFAULT 0,
  first_try_at TEXT, last_try_at TEXT, sent_at TEXT, email_id TEXT, figures TEXT, error TEXT, alerted_at TEXT,
  pdf_b64 TEXT, csv TEXT, opened_at TEXT, opened_by TEXT, filed_at TEXT, filed_by TEXT, confirmation TEXT, reminded_at TEXT)`;

/** Columns added after the table first went live (2026-11-08), added to an older table in place */
const ADDED = ['pdf_b64', 'csv', 'opened_at', 'opened_by', 'filed_at', 'filed_by', 'confirmation', 'reminded_at'];

/** The store's Georgia Tax Center sign-in details, typed in once on the filing page. Never the password. */
const SETTINGS = `CREATE TABLE IF NOT EXISTS sales_tax_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)`;

const _ready = new WeakSet();
/** Makes the tables, or brings an older one up to date. Nothing to migrate by hand. */
export async function ensureTable(DB) {
  if (_ready.has(DB)) return;
  await DB.prepare(SCHEMA).run();
  await DB.prepare(SETTINGS).run();
  const have = new Set(((await DB.prepare('PRAGMA table_info(sales_tax_months)').all()).results || []).map((c) => c.name));
  for (const col of ADDED) {
    if (have.has(col)) continue;
    // The worker and the admin can both upgrade the table at once; the second one finds the column already there
    await DB.prepare(`ALTER TABLE sales_tax_months ADD COLUMN ${col} TEXT`)
      .run()
      .catch((err) => {
        if (!/duplicate column/i.test(String(err?.message || err))) throw err;
      });
  }
  _ready.add(DB);
}

export const isMonth = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** When the next month's email goes: the 1st of next month at 8 AM Eastern, or today if it's the 1st before 8 */
export function nextSend(now) {
  const e = eastern(now);
  const onFirst = e.day === 1 && e.hour < SEND_HOUR_ET;
  const y = onFirst ? e.year : e.month === 12 ? e.year + 1 : e.year;
  const m = onFirst ? e.month : e.month === 12 ? 1 : e.month + 1;
  const prior = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const words = new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return { month: prior, words: `${words} at ${SEND_HOUR_ET} AM` };
}

/** Whole days from today (Eastern) to a 'YYYY-MM-DD' date: 0 on the day, negative after */
export function daysUntil(iso, now) {
  const e = eastern(now);
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(e.year, e.month - 1, e.day)) / 864e5);
}

/** How a due date reads from today: '12 days left', 'Due tomorrow', 'Due today', '2 days late' */
export const daysLeftWords = (n) => (n > 1 ? `${n} days left` : n === 1 ? 'Due tomorrow' : n === 0 ? 'Due today' : `${-n} ${n === -1 ? 'day' : 'days'} late`);

/**
 * @typedef {{ at: string, by: string | null, confirmation: string | null }} Filed
 * @typedef {{ month: string, name: string, state: string, tries: number, at: string | null, error: string | null, due: string, filed: Filed | null }} MonthRow
 * @typedef {{
 *   due: string | null,
 *   dueName: string | null,
 *   last: { month: string, name: string, at: string | null } | null,
 *   problem: { month: string, name: string, error: string, tries: number, at: string | null } | null,
 *   waiting: boolean,
 *   unreadable: boolean,
 *   toFile: { month: string, name: string, due: string, dueWords: string, daysLeft: number } | null,
 *   next: { month: string, words: string },
 *   months: MonthRow[],
 * }} SalesTaxFacts
 */

/**
 * For the admin's Sales tax page. Never an address or an amount.
 * @param {any} DB D1 database (the admin's env.DB)
 * @param {{ now?: number }} [options]
 * @returns {Promise<SalesTaxFacts>}
 */
export async function salesTaxFacts(DB, { now = Date.now() } = {}) {
  const due = dueMonth(now);
  /** @type {SalesTaxFacts} */
  const out = { due, dueName: due ? monthName(due) : null, last: null, problem: null, waiting: false, unreadable: false, toFile: null, next: nextSend(now), months: [] };
  /** @type {Array<{ month: string, state: string, tries: number, last_try_at: string | null, sent_at: string | null, error: string | null, filed_at: string | null, filed_by: string | null, confirmation: string | null }>} */
  let list = [];
  if (DB) {
    try {
      await ensureTable(DB);
      list = (await DB.prepare('SELECT month, state, tries, last_try_at, sent_at, error, filed_at, filed_by, confirmation FROM sales_tax_months ORDER BY month DESC LIMIT 12').all()).results || [];
    } catch (err) {
      // Said plainly on the page, rather than looking like nothing has been tried
      console.error('Sales tax status:', err);
      out.unreadable = true;
      return out;
    }
  }
  out.months = list.map((r) => ({
    month: r.month,
    name: monthName(r.month),
    state: r.state,
    tries: r.tries,
    at: r.sent_at || r.last_try_at,
    error: r.state === 'sent' ? null : r.error,
    due: dueDate(r.month).iso,
    filed: r.filed_at ? { at: r.filed_at, by: r.filed_by, confirmation: r.confirmation } : null,
  }));
  const sent = list.find((r) => r.state === 'sent');
  if (sent) out.last = { month: sent.month, name: monthName(sent.month), at: sent.sent_at };
  const open = due ? list.find((r) => r.month === due) : null;
  if (due && open?.state !== 'sent') {
    if (open?.error) out.problem = { month: due, name: monthName(due), error: open.error, tries: open.tries, at: open.last_try_at };
    else out.waiting = true;
  }
  // A month from before that never went (the worker keeps trying it for two more months): shown until it goes
  const late = !out.problem ? list.find((r) => r.state !== 'sent' && r.error && due && r.month < due) : null;
  if (late) out.problem = { month: late.month, name: monthName(late.month), error: late.error, tries: late.tries, at: late.last_try_at };
  // The newest month sent and not yet filed
  const unfiled = list.find((r) => r.state === 'sent' && !r.filed_at);
  if (unfiled) {
    const d = dueDate(unfiled.month);
    out.toFile = { month: unfiled.month, name: monthName(unfiled.month), due: d.iso, dueWords: d.words, daysLeft: daysUntil(d.iso, now) };
  }
  return out;
}

/**
 * One month for its filing page: the figures sent, whether the PDF and spreadsheet are kept, and the filing record.
 * Notes that the page was opened (the first time only), which with filed_at says how long filing took.
 * @param {any} DB
 * @param {string} month 'YYYY-MM'
 * @param {{ now?: number, viewer?: string | null }} [options] viewer: who's opening the page; leave it out to read without noting it
 */
export async function monthRecord(DB, month, { now = Date.now(), viewer = null } = {}) {
  if (!DB || !isMonth(month)) return null;
  await ensureTable(DB);
  const row = await DB.prepare(
    "SELECT month, state, sent_at, figures, COALESCE(pdf_b64, '') != '' AS has_pdf, COALESCE(csv, '') != '' AS has_csv, opened_at, opened_by, filed_at, filed_by, confirmation FROM sales_tax_months WHERE month = ?",
  )
    .bind(month)
    .first();
  if (!row || row.state !== 'sent' || !row.figures) return null;
  if (!row.opened_at && viewer) {
    const iso = new Date(now).toISOString();
    await DB.prepare('UPDATE sales_tax_months SET opened_at = ?, opened_by = ? WHERE month = ? AND opened_at IS NULL').bind(iso, viewer, month).run();
    row.opened_at = iso;
    row.opened_by = viewer;
  }
  let figures = null;
  try {
    figures = JSON.parse(row.figures);
  } catch {
    return null;
  }
  return {
    month,
    name: monthName(month),
    sentAt: row.sent_at,
    figures,
    files: { pdf: !!row.has_pdf, csv: !!row.has_csv },
    opened: row.opened_at ? { at: row.opened_at, by: row.opened_by } : null,
    filed: row.filed_at ? { at: row.filed_at, by: row.filed_by, confirmation: row.confirmation } : null,
  };
}

/**
 * Marks a sent month filed (confirmation: the Georgia Tax Center's, optional), or takes the mark off. → true when it changed
 * @param {any} DB
 * @param {string} month 'YYYY-MM'
 * @param {{ filed: boolean, by?: string | null, confirmation?: string | null, now?: number }} options
 */
export async function setFiled(DB, month, { filed, by = null, confirmation = null, now = Date.now() }) {
  if (!isMonth(month)) return false;
  await ensureTable(DB);
  const conf = typeof confirmation === 'string' ? confirmation.trim().replace(/\s+/g, ' ').slice(0, 64) || null : null;
  const r = filed
    ? await DB.prepare("UPDATE sales_tax_months SET filed_at = ?, filed_by = ?, confirmation = ? WHERE month = ? AND state = 'sent'")
        .bind(new Date(now).toISOString(), by, conf, month)
        .run()
    : await DB.prepare("UPDATE sales_tax_months SET filed_at = NULL, filed_by = NULL, confirmation = NULL WHERE month = ? AND state = 'sent'").bind(month).run();
  return !!r?.meta?.changes;
}

/** The PDF or spreadsheet kept with a sent month → { body, type, filename } or null */
export async function monthFile(DB, month, kind) {
  if (!isMonth(month) || !['pdf', 'csv'].includes(kind)) return null;
  await ensureTable(DB);
  const row = await DB.prepare(`SELECT ${kind === 'pdf' ? 'pdf_b64' : 'csv'} AS v FROM sales_tax_months WHERE month = ? AND state = 'sent'`).bind(month).first();
  if (!row?.v) return null;
  const filename = `Sunny & Ranney sales ${monthName(month)}.${kind}`;
  if (kind === 'csv') return { body: row.v, type: 'text/csv; charset=utf-8', filename };
  const bin = atob(row.v);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { body: bytes, type: 'application/pdf', filename };
}

// ─── Signing in to the Georgia Tax Center ────────────────────────────

/** Where the Tax Center signs in. Its bare address (gtc.dor.ga.gov/) answers 404; this one is its home page. */
export const TAX_CENTER = 'https://gtc.dor.ga.gov/_/';
export const TAX_CENTER_PHONE = '877-423-6711';

const LOGIN_KEYS = { username: 'gtc_username', stn: 'gtc_stn', codeNote: 'gtc_code_note' };
const LIMITS = { username: 64, stn: 20, codeNote: 80 };

/**
 * The store's Tax Center sign-in details as saved on the filing page: username, sales tax number (STN), and who
 * gets the two-step code. Managers only see them. The password is never kept; it lives in the browser.
 * @returns {Promise<{ username: string, stn: string, codeNote: string, updatedAt: string | null, updatedBy: string | null }>}
 */
export async function taxCenterLogin(DB) {
  const out = { username: '', stn: '', codeNote: '', updatedAt: null, updatedBy: null };
  if (!DB) return out;
  await ensureTable(DB);
  const rows = (await DB.prepare("SELECT key, value, updated_at, updated_by FROM sales_tax_settings WHERE key LIKE 'gtc_%'").all()).results || [];
  for (const [field, key] of Object.entries(LOGIN_KEYS)) {
    const row = rows.find((r) => r.key === key);
    if (!row) continue;
    out[field] = row.value || '';
    if (!out.updatedAt || row.updated_at > out.updatedAt) {
      out.updatedAt = row.updated_at;
      out.updatedBy = row.updated_by;
    }
  }
  return out;
}

/**
 * Saves the sign-in details. Anything that looks like a password is refused, so it can't end up here by mistake.
 * @param {any} DB
 * @param {{ username?: unknown, stn?: unknown, codeNote?: unknown, by?: string | null, now?: number }} input
 * @returns {Promise<{ ok: true } | { error: string }>}
 */
export async function saveTaxCenterLogin(DB, { username, stn, codeNote, by = null, now = Date.now() }) {
  const clean = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
  const values = { username: clean(username, LIMITS.username), stn: clean(stn, LIMITS.stn), codeNote: clean(codeNote, LIMITS.codeNote) };
  if (/\s/.test(values.username)) return { error: 'A Tax Center username has no spaces.' };
  if (values.stn && !/^[0-9A-Za-z-]+$/.test(values.stn.replace(/ /g, ''))) return { error: 'The sales tax number is digits and dashes, like 123-456789.' };
  if (/pass(word)?\s*[:=]/i.test(`${values.username} ${values.codeNote}`)) return { error: 'Don’t save the password here. Keep it in your browser or password manager.' };
  await ensureTable(DB);
  const iso = new Date(now).toISOString();
  // All three or none
  const upsert = 'INSERT INTO sales_tax_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by';
  await DB.batch(Object.entries(LOGIN_KEYS).map(([field, key]) => DB.prepare(upsert).bind(key, values[field], iso, by)));
  return { ok: true };
}
