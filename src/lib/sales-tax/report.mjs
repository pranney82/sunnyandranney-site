/**
 * The sales tax emails and Shopify's report
 * ===========================================================================
 * readyEmail(): on the 1st, last month is ready to file: what's owed, by
 * when, and a button to the month's filing page in the admin, where the
 * numbers are in the Georgia Tax Center's order. reminderEmail(): three days
 * before it's due, if the month isn't marked filed. In the store's own look:
 * cream ground, charcoal type, gold for the one panel that matters, DM Sans
 * where the mail app has it.
 *
 * salesPdf(): laid out like Shopify's own "Total sales breakdown", the pages
 * staff used to print, with every day of the month. salesCsv(): the same as a
 * spreadsheet. Both are kept with the month and downloaded from its page.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { SALES_COLUMNS, SALES_LABELS as LABELS, TZ, countyName, daysIn, dueDate, isGeorgia, money, monthName, pct, plainCents as plain } from './figures.mjs';
const countyLabel = (c) => `${countyName(c)}${c.code ? ` (${c.code})` : ''}, taxable sales`;
const taxLabel = (t) => `${t.name} (${pct(t.rate)})${t.region && !isGeorgia(t.region) ? `, ${t.region}` : ''}`;

// ─── The store's email look ──────────────────────────────────────────

/** The store's colors (src/styles/global.css) */
const C = {
  ground: '#FAF7F2',
  card: '#FFFFFF',
  ink: '#2C2C2C',
  muted: '#625D57',
  line: '#ECE6DC',
  gold: '#FFD400',
  goldWash: '#FFF8D6',
  teal: '#1A6580',
};
const SANS = "'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const LOGO = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/logo-tagline-light-bg/w=320,h=128,fit=scale-down,format=png';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const label = (t, color = C.ink) =>
  `<p style="margin:0 0 10px;font-family:${SANS};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${color};">${esc(t)}</p>`;

/** One panel of the card. accent: a gold bar down the left, for the lines that go on the return */
function panel(inner, { accent = false, wash = false } = {}) {
  const bg = wash ? C.goldWash : C.card;
  const edge = accent || wash ? `border-left:4px solid ${C.gold};` : '';
  return `<tr><td style="padding:0 0 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td style="background:${bg};border:1px solid ${C.line};${edge}border-radius:10px;padding:18px 20px 12px;">${inner}</td></tr></table></td></tr>`;
}

function shell({ title, preheader, heading, intro, body, footnote, address }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.ground};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ground};">
<tr><td align="center" style="padding:28px 12px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td style="padding:0 4px 22px;"><img src="${LOGO}" width="160" height="64" alt="Sunny &amp; Ranney" style="display:block;border:0;outline:none;width:160px;height:64px;font-family:${SANS};font-size:20px;font-weight:700;color:${C.ink};"></td></tr>
<tr><td style="padding:0 4px 20px;">
${label('Georgia sales tax', C.teal)}
<h1 style="margin:0 0 10px;font-family:${SANS};font-size:28px;line-height:34px;font-weight:700;color:${C.ink};">${esc(heading)}</h1>
<p style="margin:0;font-family:${SANS};font-size:16px;line-height:24px;color:${C.ink};">${esc(intro)}</p>
</td></tr>
${body}
<tr><td style="padding:4px 4px 0;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">${esc(footnote)}</td></tr>
<tr><td style="padding:20px 4px 0;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted};">${esc(address)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── The emails ──────────────────────────────────────────────────────

const ADDRESS = 'Sunny & Ranney · 109A Oak Street, Roswell, Georgia';

/** A button mail apps draw as one: the store's gold, charcoal type, 8px corners */
function button(href, text) {
  return `<tr><td style="padding:4px 0 22px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.gold}" style="background:${C.gold};border-radius:8px;">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:15px 26px;font-family:${SANS};font-size:14px;line-height:18px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${C.ink};text-decoration:none;border-radius:8px;">${esc(text)}</a>` +
    `</td></tr></table></td></tr>`;
}

/** The one number that matters, with the date and what filing on time keeps */
function amountPanel(r, due) {
  return panel(
    `${label('To pay')}<p style="margin:0 0 6px;font-family:${SANS};font-size:34px;line-height:40px;font-weight:700;color:${C.ink};font-variant-numeric:tabular-nums;">${esc(money(r.pay))}</p>` +
      `<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.ink};">by ${esc(due.words)}. Filed and paid by then, the store keeps ${esc(money(r.comp))} of the tax as vendor’s compensation.</p>`,
    { accent: true },
  );
}

const checkFirst = (f) =>
  f.notes.length
    ? panel(
        `${label('Check first')}<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.ink};">${f.notes.length === 1 ? 'There’s one thing' : `There are ${f.notes.length} things`} to check in Shopify before filing. ${f.notes.length === 1 ? 'It’s' : 'They’re'} at the top of the page.</p>`,
        { wash: true },
      )
    : '';

const replyLine = (replyName) => (replyName ? `Questions: reply, and it goes to ${replyName}.` : 'Questions: reply to this email.');
const signIn = 'Sign in with your email address and you’ll get a one-time code.';

/**
 * The 1st of the month: last month is ready to file. No figures but what's owed; they're on the filing page,
 * in the Georgia Tax Center's order with a copy button each, with Shopify's report to download.
 * f: figuresFrom(); link: the month's filing page
 */
export function readyEmail(f, { link, replyName = '' }) {
  const name = monthName(f.month);
  const short = name.split(' ')[0];
  const due = dueDate(f.month);
  const r = f.ret;
  const subject = `${name} sales tax is ready to file`;
  const preheader = `${money(r.pay)} to pay by ${due.words}.`;
  const intro = `${short}’s numbers from Shopify are in the store admin, in the order the Georgia Tax Center asks for them, each with a copy button.`;
  const footnote = `${signIn} Shopify’s report for ${short}, every day of it, is on the page as a PDF and a spreadsheet. ${replyLine(replyName)}`;
  const html = shell({ title: subject, preheader, heading: `${name} is ready to file`, intro, body: amountPanel(r, due) + checkFirst(f) + button(link, `Open ${short}’s numbers`), footnote, address: ADDRESS });
  const text = [
    intro,
    '',
    `To pay: ${money(r.pay)} by ${due.words}. Filed and paid by then, the store keeps ${money(r.comp)} of the tax as vendor’s compensation.`,
    ...(f.notes.length ? ['', `Check first: ${f.notes.length === 1 ? 'one thing' : `${f.notes.length} things`} to check in Shopify before filing, at the top of the page.`] : []),
    '',
    `Open ${short}’s numbers: ${link}`,
    '',
    footnote,
  ].join('\n');
  return { subject, html, text };
}

/** Three days before it's due, when the month isn't marked filed in the admin */
export function reminderEmail(f, { link, daysLeft, replyName = '' }) {
  const name = monthName(f.month);
  const short = name.split(' ')[0];
  const due = dueDate(f.month);
  const r = f.ret;
  const when = daysLeft <= 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  const subject = `Reminder: ${name} sales tax is due ${due.words.split(',')[0]}`;
  const preheader = `Not marked filed yet. ${money(r.pay)} to pay by ${due.words}.`;
  const intro = `Georgia’s sales tax return for ${short} is due ${due.words}, ${when}, and it isn’t marked filed in the store admin.`;
  const footnote = `Already filed? Mark it filed on the page with the Georgia Tax Center’s confirmation number, so the admin shows it. ${signIn} ${replyLine(replyName)}`;
  const html = shell({ title: subject, preheader, heading: `${short} isn’t marked filed yet`, intro, body: amountPanel(r, due) + button(link, `Open ${short}’s numbers`), footnote, address: ADDRESS });
  const text = [intro, '', `To pay: ${money(r.pay)} by ${due.words}. Filed and paid by then, the store keeps ${money(r.comp)} of the tax as vendor’s compensation.`, '', `Open ${short}’s numbers: ${link}`, '', footnote].join('\n');
  return { subject, html, text };
}

// ─── The attachments ─────────────────────────────────────────────────

/** The spreadsheet: every day as Shopify's report shows it, the month's total, then each tax */
export function salesCsv(f) {
  const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const out = [['Day', ...SALES_COLUMNS.map((k) => LABELS[k])]];
  for (const d of f.daily) out.push([d.day, ...SALES_COLUMNS.map((k) => plain(d[k]))]);
  out.push([`${monthName(f.month)} total`, ...SALES_COLUMNS.map((k) => plain(f.breakdown[k]))]);
  out.push([]);
  out.push(['Tax', 'Region', 'Rate', 'Tax collected']);
  for (const t of f.taxes) out.push([t.name, t.region || 'Georgia', pct(t.rate), plain(t.tax)]);
  return `${out.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
}

/**
 * The report as a PDF, laid out like Shopify's own "Total sales breakdown": first the taxes and the return's lines,
 * then Shopify's table, the month's total over every day. Landscape Letter, two pages for a month; drawn with
 * pdf-lib's Helvetica, so nothing is fetched. → bytes
 */
export async function salesPdf(f, { readAt = Date.now() } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ok = new Set(font.getCharacterSet());
  const clean = (s) => [...String(s ?? '')].map((ch) => (ok.has(ch.codePointAt(0)) ? ch : ch === '÷' ? '/' : '')).join('');
  const W = 792;
  const H = 612;
  const M = 40;
  const INK = rgb(0.17, 0.17, 0.17);
  const GRAY = rgb(0.38, 0.36, 0.34);
  const LINE = rgb(0.91, 0.89, 0.85);
  const BAND = rgb(0.98, 0.97, 0.95);
  const name = monthName(f.month);
  const [y0, m0] = f.month.split('-').map(Number);
  const short = (d) => new Date(Date.UTC(y0, m0 - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const read = new Date(readAt).toLocaleString('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  let page;
  let y;
  const pages = [];
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = H - M;
  };
  const text = (s, x, yy, { size = 9, f: fnt = font, color = INK, right = false } = {}) => {
    const t = clean(s);
    page.drawText(t, { x: right ? x - fnt.widthOfTextAtSize(t, size) : x, y: yy, size, font: fnt, color });
  };
  const room = (h) => {
    if (y - h < M + 14) newPage();
  };
  newPage();

  text('SUNNY & RANNEY', M, y - 8, { size: 8, f: bold, color: GRAY });
  text('Total sales breakdown', M, y - 30, { size: 18, f: bold });
  text(`${name}  ·  from Shopify, read ${read} Eastern`, M, y - 46, { size: 9, color: GRAY });
  y -= 64;

  // First what the return needs: the taxes and the return's lines, side by side
  const rowH = 13.2;
  const r = f.ret;
  const block = (title, list, x, width) => {
    let yy = y;
    text(title, x, yy - 8, { size: 10, f: bold });
    yy -= 16;
    for (const [k, v, b] of list) {
      text(k, x, yy - 7, { size: 8.6, f: b ? bold : font });
      text(v, x + width, yy - 7, { size: 8.6, f: b ? bold : font, right: true });
      page.drawLine({ start: { x, y: yy - 10 }, end: { x: x + width, y: yy - 10 }, thickness: 0.5, color: LINE });
      yy -= rowH;
    }
    return y - yy;
  };
  const taxRows = [...f.taxes.map((t) => [taxLabel(t), money(t.tax)]), ['Total', money(f.taxes.reduce((a, t) => a + t.tax, 0)), true]];
  const retRows = [
    ['Line 1, total sales', money(r.totalSales)],
    ['Line 2, exempt sales', money(r.exempt)],
    ['Line 3, taxable sales', money(r.taxable), true],
    ...r.counties.map((c) => [countyLabel(c), money(c.taxable)]),
    ['Line 7, tax collected', money(r.collected), true],
    ['Vendor’s compensation (on time)', money(-r.comp)],
    [`Due by ${dueDate(f.month).words}`, money(r.pay), true],
  ];
  const half = (W - M * 2 - 40) / 2;
  room(Math.max(taxRows.length, retRows.length) * rowH + 24);
  const used = Math.max(block('Sales taxes', taxRows, M, half), block('For the Georgia return (ST-3)', retRows, M + half + 40, half));
  y -= used + 12;
  // Anything to check before filing, wrapped to the page
  for (const n of f.notes) {
    const lines = [];
    let cur = 'Check before filing: ';
    for (const w of clean(n).split(/\s+/)) {
      if (font.widthOfTextAtSize(`${cur}${w}`, 8.4) > W - M * 2 && cur.trim()) {
        lines.push(cur.trimEnd());
        cur = '';
      }
      cur += `${w} `;
    }
    lines.push(cur.trimEnd());
    for (const l of lines) {
      room(rowH);
      text(l, M, y - 8, { size: 8.4, color: INK });
      y -= 11.5;
    }
    y -= 4;
  }
  y -= 10;

  // Then Shopify's table: the month's total on top, every day under it, the header again on a new page
  const cols = SALES_COLUMNS.map((k) => LABELS[k]);
  const dayW = 108;
  const colW = (W - M * 2 - dayW) / cols.length;
  const row = (lbl, vals, { b = false, band = false } = {}) => {
    room(rowH);
    if (band) page.drawRectangle({ x: M, y: y - rowH + 3.4, width: W - M * 2, height: rowH, color: BAND });
    text(lbl, M + 4, y - 6.8, { size: 8.6, f: b ? bold : font });
    vals.forEach((v, i) => text(v, M + dayW + colW * (i + 1) - 4, y - 6.8, { size: 8.6, f: b ? bold : font, right: true }));
    page.drawLine({ start: { x: M, y: y - rowH + 3.4 }, end: { x: W - M, y: y - rowH + 3.4 }, thickness: 0.5, color: LINE });
    y -= rowH;
  };
  const header = () => {
    room(rowH * 3);
    text('Day', M + 4, y - 8, { size: 8, f: bold, color: GRAY });
    cols.forEach((c, i) => text(c, M + dayW + colW * (i + 1) - 4, y - 8, { size: 8, f: bold, color: GRAY, right: true }));
    page.drawLine({ start: { x: M, y: y - 13 }, end: { x: W - M, y: y - 13 }, thickness: 0.8, color: GRAY });
    y -= 16;
  };
  header();
  row(`${short(1).replace(/, \d+$/, '')} to ${daysIn(f.month)}, ${y0}`, SALES_COLUMNS.map((k) => money(f.breakdown[k])), { b: true, band: true });
  for (const d of f.daily) {
    if (y - rowH < M + 14) {
      newPage();
      header();
    }
    row(short(Number(d.day.slice(8))), SALES_COLUMNS.map((k) => money(d[k])));
  }

  pages.forEach((p, i) => {
    page = p;
    text(`Page ${i + 1} of ${pages.length}`, W - M, M - 18, { size: 7.5, color: GRAY, right: true });
    text('Taxable sales are the tax Shopify collected divided by its rate.', M, M - 18, { size: 7.5, color: GRAY });
  });
  doc.setTitle(`Sunny & Ranney sales ${name}`);
  doc.setAuthor('Sunny & Ranney');
  return doc.save();
}
