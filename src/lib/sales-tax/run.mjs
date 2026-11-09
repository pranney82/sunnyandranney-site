/**
 * The monthly run: last month's sales tax, ready to file, once
 * ===========================================================================
 * The sales-tax worker (workers/sales-tax) calls maybeRunSalesTax() every 30
 * minutes.
 *
 *  - From 8 AM Eastern on the 1st it reads last month out of Shopify, keeps
 *    the figures, the PDF and the spreadsheet with the month, and emails the
 *    store that it's ready to file, with a button to the month's filing page.
 *  - From 8 AM three days before it's due, if the month isn't marked filed in
 *    the admin, it reminds the store once.
 *  - A month sent before files were kept gets them, read again from Shopify,
 *    only when Shopify's numbers still match what was sent.
 *
 * D1 sales_tax_months (status.mjs) keeps each month. A month is claimed with
 * one upsert that never touches a sent month and never retries sooner than 20
 * minutes after the last try, so two runs at once send one email. After 2
 * hours of failing, the owner hears once; the admin's Sales tax page shows the
 * problem until it goes.
 *
 * Who it goes to lives in the worker's secrets, not here: this repo is public.
 *   SALES_TAX_TO         the store manager
 *   SALES_TAX_CC         copied, comma-separated
 *   SALES_TAX_REPLY_TO   where a reply goes
 *   SALES_TAX_ALERT_TO   who hears when it fails, comma-separated
 *   SALES_TAX_REPLY_NAME (plain var) the name the emails give for replies
 */

import { SEND_HOUR_ET, dueDate, dueMonth, eastern, monthName, readMonth } from './figures.mjs';
import { esc, readyEmail, reminderEmail, salesCsv, salesPdf } from './report.mjs';
import { daysUntil, ensureTable } from './status.mjs';

export const FROM = { email: 'reports@mail.sunnyandranney.com', name: 'Sunny & Ranney' };
export const ADMIN_ORIGIN = 'https://admin.sunnyandranney.com';
export const ADMIN_PAGE = `${ADMIN_ORIGIN}/admin/sales-tax/`;
export const monthPage = (month) => `${ADMIN_PAGE}${month}/`;
const MIN = 60e3;
// The cron runs every 30 minutes, give or take a second, so a 30-minute wait would skip every other run.
// 20 minutes lets each run retry and still keeps two runs at once from both sending.
const RETRY_MS = 20 * MIN;
const ALERT_AFTER_MS = 2 * 60 * MIN;
export const REMIND_DAYS = 3;

export const addresses = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));

/** What's missing before it can send, in words for the admin page, or null */
export function setupProblem(env) {
  if (!env?.SHOPIFY_CLIENT_ID || !env?.SHOPIFY_CLIENT_SECRET) {
    return 'The Shopify app’s keys (SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET) aren’t on the sales-tax worker in Cloudflare yet.';
  }
  if (!addresses(env.SALES_TAX_TO).length) return 'No one to send to: SALES_TAX_TO isn’t set on the sales-tax worker.';
  if (!env.EMAIL?.send) return 'The sales-tax worker has no EMAIL binding to send with.';
  return null;
}

/** Cloudflare Email Service, through the worker's send_email binding → { id } */
export async function sendWithBinding(env, message) {
  try {
    const r = await env.EMAIL.send({ from: FROM, ...message });
    return { id: r?.messageId || null };
  } catch (err) {
    throw new Error(`The email didn’t send: ${err?.code ? `${err.code}: ` : ''}${err?.message || err}`);
  }
}

/** The store's people: the manager, those copied, and where a reply goes */
function storeRecipients(env) {
  const cc = addresses(env.SALES_TAX_CC);
  const replyTo = addresses(env.SALES_TAX_REPLY_TO)[0];
  return { to: addresses(env.SALES_TAX_TO), ...(cc.length ? { cc } : {}), ...(replyTo ? { replyTo } : {}) };
}

/** The owner's one email when a month's numbers haven't gone after 2 hours */
async function alertByEmail(env, card) {
  const to = addresses(env.SALES_TAX_ALERT_TO);
  if (!to.length) return;
  await sendWithBinding(env, {
    to,
    subject: card.title,
    text: `${card.detail}\n\n${card.fix}\n\n${ADMIN_PAGE}`,
    html: `<p>${esc(card.detail)}</p><p>${esc(card.fix)}</p><p><a href="${ADMIN_PAGE}">Sales tax in the store admin</a></p>`,
  });
}

/** Text or bytes → base64, a chunk at a time (a PDF is too big for one String.fromCharCode) */
export function b64(v) {
  const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The return's lines as sent, to tell whether Shopify still says the same */
const sameReturn = (a, b) =>
  ['totalSales', 'exempt', 'taxable', 'collected', 'comp', 'pay'].every((k) => a?.[k] === b?.[k]) &&
  JSON.stringify((a?.counties || []).map((c) => [c.code, c.taxable])) === JSON.stringify((b?.counties || []).map((c) => [c.code, c.taxable]));

/**
 * Every 30 minutes: last month's email, once, from 8 AM Eastern on the 1st; then, until it's filed, one reminder. Never throws.
 * A month that still hasn't gone when the next one comes due is tried too, for two more months, after the due one.
 * send(env, message) → { id }, throws when it doesn't go. alert(env, card) tells the owner.
 */
export async function maybeRunSalesTax(env, { now = Date.now(), fetchImpl = fetch, send = sendWithBinding, alert = alertByEmail } = {}) {
  const DB = env?.DB;
  if (!DB) return { ran: false, why: 'no database' };
  const month = dueMonth(now);
  if (!month) return { ran: false, why: 'before 8am on the 1st' };
  try {
    await ensureTable(DB);
    const iso = new Date(now).toISOString();
    const opts = { now, iso, fetchImpl, send, alert };
    const row = await DB.prepare('SELECT state, figures, pdf_b64 IS NULL AS no_files, filed_at, reminded_at FROM sales_tax_months WHERE month = ?').bind(month).first();
    const result = row?.state === 'sent' ? await afterSending(env, { month, row, ...opts }) : await sendMonth(env, month, opts);
    const late = (await DB.prepare("SELECT month FROM sales_tax_months WHERE state != 'sent' AND month < ? AND month >= ? ORDER BY month").bind(month, monthsBefore(month, 2)).all()).results || [];
    const older = [];
    for (const { month: m } of late) {
      const r = await sendMonth(env, m, opts);
      if (r.ran || r.why === 'error') older.push({ month: m, ...r });
    }
    return older.length ? { ...result, older } : result;
  } catch (err) {
    console.error('Sales tax:', err);
    return { ran: false, why: 'error', error: String(err?.message || err) };
  }
}

/** 'YYYY-MM' n months earlier */
function monthsBefore(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** One month not yet sent: claim it, read Shopify, keep the report, email the store. Throws only on a database failure. */
async function sendMonth(env, month, { now, iso, fetchImpl, send, alert }) {
  const DB = env.DB;
  // Claim the month: never one already sent, never sooner than 20 minutes after the last try
  const claim = await DB.prepare(
    `INSERT INTO sales_tax_months (month, state, tries, first_try_at, last_try_at) VALUES (?, 'trying', 1, ?, ?)
    ON CONFLICT(month) DO UPDATE SET tries = sales_tax_months.tries + 1, last_try_at = excluded.last_try_at, state = 'trying'
    WHERE sales_tax_months.state != 'sent' AND (sales_tax_months.last_try_at IS NULL OR sales_tax_months.last_try_at < ?)`,
  )
    .bind(month, iso, iso, new Date(now - RETRY_MS).toISOString())
    .run();
  if (!claim?.meta?.changes) return { ran: false, why: 'sent or tried lately' };

  let f;
  let pdf;
  let r;
  try {
    const missing = setupProblem(env);
    if (missing) throw new Error(missing);
    f = await readMonth(env, month, { fetchImpl });
    // Shopify's report read wrong: better no email than wrong numbers
    if (f.problems.length) throw new Error(`${f.problems.join(' ')} Nothing was sent.`);
    pdf = await salesPdf(f, { readAt: now });
    const m = readyEmail(f, { link: monthPage(month), replyName: env.SALES_TAX_REPLY_NAME || '' });
    r = await send(env, { ...storeRecipients(env), subject: m.subject, html: m.html, text: m.text });
  } catch (err) {
    const why = String(err?.message || err).slice(0, 400);
    await DB.prepare("UPDATE sales_tax_months SET state = 'failed', error = ? WHERE month = ?").bind(why, month).run();
    const first = await DB.prepare('SELECT first_try_at, alerted_at FROM sales_tax_months WHERE month = ?').bind(month).first();
    if (!first?.alerted_at && now - Date.parse(first?.first_try_at || iso) >= ALERT_AFTER_MS) {
      // Marked only once it's gone, so an alert that fails is tried again on the next run
      try {
        await alert(env, {
          title: `${monthName(month)} sales tax numbers didn’t go to the store`,
          detail: `The store admin couldn’t send the store its Georgia sales tax numbers for ${monthName(month)}: ${why}`,
          fix: 'It keeps trying every 30 minutes. Until it goes, the store can print Shopify’s Total sales breakdown and Copy of Taxes reports for the month by hand.',
        });
        await DB.prepare('UPDATE sales_tax_months SET alerted_at = ? WHERE month = ?').bind(iso, month).run();
      } catch (e) {
        console.error('Sales tax alert:', e);
      }
    }
    return { ran: false, why: 'error', error: why };
  }

  // The email has gone: from here nothing may mark the month failed, or the next run would send it again
  try {
    await DB.prepare("UPDATE sales_tax_months SET state = 'sent', sent_at = ?, email_id = ?, figures = ?, pdf_b64 = ?, csv = ?, error = NULL WHERE month = ?")
      .bind(iso, r?.id || null, JSON.stringify(f), b64(pdf), salesCsv(f), month)
      .run();
  } catch (err) {
    console.error('Sales tax: sent, but the month’s record didn’t save in full:', err);
    await DB.prepare("UPDATE sales_tax_months SET state = 'sent', sent_at = ?, email_id = ?, figures = ?, error = NULL WHERE month = ?")
      .bind(iso, r?.id || null, JSON.stringify({ ...f, daily: undefined }), month)
      .run()
      .catch((e) => console.error('Sales tax: sent, and the month couldn’t be marked sent:', e));
  }
  return { ran: true, sent: month };
}

/** A sent month: its files if it has none yet, then the one reminder if it's close to due and not filed */
async function afterSending(env, { month, row, now, iso, fetchImpl, send }) {
  const DB = env.DB;
  let sent;
  try {
    sent = JSON.parse(row.figures);
  } catch {
    return { ran: false, why: 'sent or tried lately' };
  }
  const done = {};

  // Files for a month sent before they were kept: Shopify read again, kept only if it still says what was sent.
  // An empty string marks a month whose numbers have moved since, so it isn't read every 30 minutes.
  if (row.no_files && !setupProblem(env)) {
    try {
      const f = await readMonth(env, month, { fetchImpl });
      if (!f.problems.length && sameReturn(f.ret, sent.ret)) {
        await DB.prepare('UPDATE sales_tax_months SET figures = ?, pdf_b64 = ?, csv = ? WHERE month = ? AND pdf_b64 IS NULL')
          .bind(JSON.stringify({ ...sent, daily: f.daily, breakdown: f.breakdown }), b64(await salesPdf(f, { readAt: now })), salesCsv(f), month)
          .run();
        done.files = 'kept';
      } else {
        await DB.prepare("UPDATE sales_tax_months SET pdf_b64 = '', csv = '' WHERE month = ? AND pdf_b64 IS NULL").bind(month).run();
        done.files = 'shopify changed';
      }
    } catch (err) {
      console.error('Sales tax files:', err);
    }
  }

  // The reminder: from 8 AM three days before it's due, through the day it's due, once, if not marked filed
  const daysLeft = daysUntil(dueDate(month).iso, now);
  const time = daysLeft >= 0 && (daysLeft < REMIND_DAYS || (daysLeft === REMIND_DAYS && eastern(now).hour >= SEND_HOUR_ET));
  if (time && !row.filed_at && !row.reminded_at && addresses(env.SALES_TAX_TO).length && env.EMAIL) {
    const claim = await DB.prepare('UPDATE sales_tax_months SET reminded_at = ? WHERE month = ? AND reminded_at IS NULL AND filed_at IS NULL').bind(iso, month).run();
    if (claim?.meta?.changes) {
      try {
        const m = reminderEmail(sent, { link: monthPage(month), daysLeft, replyName: env.SALES_TAX_REPLY_NAME || '' });
        await send(env, { ...storeRecipients(env), subject: m.subject, html: m.html, text: m.text });
        done.reminded = month;
      } catch (err) {
        console.error('Sales tax reminder:', err);
        await DB.prepare('UPDATE sales_tax_months SET reminded_at = NULL WHERE month = ?').bind(month).run();
      }
    }
  }
  return Object.keys(done).length ? { ran: true, ...done } : { ran: false, why: 'sent or tried lately' };
}
