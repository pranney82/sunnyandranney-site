/**
 * Sunny & Ranney's monthly sales tax email: Shopify's reports → Georgia's return lines → the store
 * Run: npm test (or node --test src/lib/sales-tax)
 *
 * The month here is made up. The store's real figures stay out of this public repo.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { cents, countyOf, dueDate, dueMonth, figuresFrom, gtcReturn, money, queries, rateOf, readCents, shopifyql, shopifyToken, vendorComp } from './figures.mjs';
import { esc, readyEmail, reminderEmail, salesCsv, salesPdf } from './report.mjs';
import { FROM, maybeRunSalesTax, monthPage, sendWithBinding, setupProblem } from './run.mjs';
import { SCHEMA as SCHEMA_SQL, TAX_CENTER, daysLeftWords, daysUntil, ensureTable, monthFile, monthRecord, nextSend, salesTaxFacts, saveTaxCenterLogin, setFiled, taxCenterLogin } from './status.mjs';

const MIN = 60e3;
// 8 AM Eastern on November 1, 2026 (standard time from 2 AM that day): 13:00 UTC
const NOV1_8AM = Date.parse('2026-11-01T13:00:00Z');

// A made-up month: one county, Fulton, 7.75%
const SAMPLE = {
  total: [{ gross_sales: '50000.00', discounts: '-12000.00', sales_reversals: '-25.00', net_sales: '37975.00', shipping_charges: '0.00', return_fees: '0.00', taxes: '2867.86', total_sales: '40842.86' }],
  days: [
    { day: '2026-10-01', gross_sales: '600.00', discounts: '-150.00', sales_reversals: '-25.00', net_sales: '425.00', shipping_charges: '0', return_fees: '0', taxes: '32.94', total_sales: '457.94' },
    { day: '2026-10-03', gross_sales: '49400', discounts: '-11850', sales_reversals: '0', net_sales: '37550', shipping_charges: '0', return_fees: '0', taxes: '2834.92', total_sales: '40384.92' },
  ],
  regions: [{ shipping_region: null, net_sales: '37975.00', shipping_charges: '0.00' }],
  taxes: [
    { tax_region: 'Georgia', tax_name: 'Georgia State Tax', tax_rate: '0.04', sales_taxes: '1480.19' },
    { tax_region: 'Georgia', tax_name: 'Fulton County Tax', tax_rate: '0.03', sales_taxes: '1110.10' },
    { tax_region: 'Georgia', tax_name: 'Fulton Co Tsplost Sp', tax_rate: '0.0075', sales_taxes: '277.57' },
  ],
};

// ─── Real D1 (Miniflare's local SQLite) ──────────────────────────────

const mfs = [];
after(() => Promise.all(mfs.map((m) => m.dispose())));
let dbCount = 0;
async function createD1() {
  const mf = new Miniflare({ modules: true, script: 'export default {}', d1Databases: { DB: `sales-tax-test-${dbCount++}` } });
  mfs.push(mf);
  return mf.getD1Database('DB');
}

// ─── Dates and money ─────────────────────────────────────────────────

test('the month to file: from 8 AM Eastern on the 1st, the month before', () => {
  assert.equal(dueMonth(NOV1_8AM - MIN), null, '7:59 on the 1st is too early');
  assert.equal(dueMonth(NOV1_8AM), '2026-10');
  assert.equal(dueMonth(Date.parse('2026-11-19T15:00:00Z')), '2026-10', 'all month long until it goes');
  assert.equal(dueMonth(Date.parse('2027-01-01T13:00:00Z')), '2026-12', 'January files December');
  assert.equal(dueMonth(Date.parse('2026-10-01T11:59:00Z')), null, 'daylight time: 7:59 AM is 11:59 UTC');
  assert.equal(dueMonth(Date.parse('2026-10-01T12:00:00Z')), '2026-09');
});

test('the return is due the 20th of the next month, a weekend moved to Monday', () => {
  assert.equal(dueDate('2026-10').iso, '2026-11-20');
  assert.equal(dueDate('2026-10').words, 'Friday, November 20');
  assert.equal(dueDate('2026-12').iso, '2027-01-20', 'December’s is due in January');
  assert.equal(dueDate('2027-02').iso, '2027-03-22', 'March 20, 2027 is a Saturday');
});

test('the next email: the 1st at 8 AM, for the month before', () => {
  assert.deepEqual(nextSend(Date.parse('2026-11-08T15:00:00Z')), { month: '2026-11', words: 'Tuesday, December 1 at 8 AM' });
  assert.deepEqual(nextSend(NOV1_8AM - MIN), { month: '2026-10', words: 'Sunday, November 1 at 8 AM' }, 'the 1st before 8: today');
  assert.deepEqual(nextSend(Date.parse('2026-12-15T15:00:00Z')), { month: '2026-12', words: 'Friday, January 1 at 8 AM' });
});

test('rates and money read the way ShopifyQL gives them, and anything else is caught', () => {
  for (const [v, r] of [['4%', 0.04], ['0.04', 0.04], ['4', 0.04], [4, 0.04], ['0.75%', 0.0075], ['0.0075', 0.0075], ['0.75', 0.0075], ['3', 0.03], ['', 0], [null, 0]]) {
    assert.ok(Math.abs(rateOf(v) - r) < 1e-12, `${v} → ${r}`);
  }
  assert.equal(cents('-13830.31'), -1383031);
  assert.equal(cents('123.456'), 12346);
  assert.equal(cents('-30'), -3000, 'Shopify drops trailing zeros');
  assert.equal(readCents({ amount: '12.50', currencyCode: 'USD' }), 1250);
  assert.equal(readCents('$1,234.50'), 123450);
  assert.equal(readCents(null), 0, 'an empty cell is nothing');
  assert.equal(readCents('n/a'), null, 'text isn’t money');
  assert.equal(readCents({ value: 1 }), null);
  assert.equal(money(-1383031), '-$13,830.31');
  assert.equal(countyOf('Fulton County Tax'), 'Fulton');
  assert.equal(countyOf('Fulton Co Tsplost Sp'), 'Fulton');
});

// ─── The figures ─────────────────────────────────────────────────────

test('one county: the return’s lines from the tax collected, every day of the month', () => {
  const f = figuresFrom('2026-10', SAMPLE);
  assert.equal(f.breakdown.net_sales, 3797500);
  assert.equal(f.breakdown.total_sales, 4084286);
  assert.equal(f.daily.length, 31, 'every day, as Shopify’s report shows them');
  assert.deepEqual(f.daily[1], { day: '2026-10-02', gross_sales: 0, discounts: 0, sales_reversals: 0, net_sales: 0, shipping_charges: 0, return_fees: 0, taxes: 0, total_sales: 0 }, 'a day with no sales is zeros');
  const r = f.ret;
  assert.equal(r.collected, 286786, 'line 7: every Georgia tax');
  assert.equal(r.taxable, Math.round(286786 / 0.0775), 'line 3: state and county tax over 7.75%');
  assert.equal(r.totalSales, 3797500, 'line 1: the store’s sales');
  assert.equal(r.exempt, 3797500 - r.taxable, 'line 2: what wasn’t taxed');
  assert.deepEqual(r.counties.map((c) => [c.name, c.code, c.taxable]), [['Fulton', '060', r.taxable]], 'Part B: Fulton (060)');
  assert.equal(r.comp, Math.round(286786 * 0.03), '3% under $3,000 of tax');
  assert.equal(r.pay, 286786 - r.comp);
  assert.deepEqual(f.notes, [], 'nothing to check');
  assert.deepEqual(f.problems, []);
  assert.deepEqual(f.taxes.map((t) => t.name), ['Georgia State Tax', 'Fulton County Tax', 'Fulton Co Tsplost Sp'], 'biggest rate first');
});

test('vendor’s compensation: 3% of the first $3,000, 0.5% of the rest', () => {
  const big = figuresFrom('2026-10', {
    ...SAMPLE,
    taxes: [
      { tax_region: 'Georgia', tax_name: 'Georgia State Tax', tax_rate: '4%', sales_taxes: '2400.00' },
      { tax_region: 'Georgia', tax_name: 'Fulton County Tax', tax_rate: '3%', sales_taxes: '1800.00' },
      { tax_region: 'Georgia', tax_name: 'Fulton Co Tsplost Sp', tax_rate: '0.75%', sales_taxes: '450.00' },
    ],
  });
  assert.equal(big.ret.collected, 465000);
  assert.equal(big.ret.comp, 9000 + Math.round(165000 * 0.005));
});

test('sales shipped away, another county and another state are each said plainly', () => {
  const f = figuresFrom('2026-10', {
    ...SAMPLE,
    total: [{ ...SAMPLE.total[0], taxes: '2967.86', total_sales: '40942.86' }],
    regions: [{ shipping_region: null, net_sales: '36975.00', shipping_charges: '0' }, { shipping_region: 'Georgia', net_sales: '500.00', shipping_charges: '0' }, { shipping_region: 'Tennessee', net_sales: '500.00', shipping_charges: '0' }],
    taxes: [
      ...SAMPLE.taxes,
      { tax_region: 'Georgia', tax_name: 'Cobb County Tax', tax_rate: '0.02', sales_taxes: '10.00' },
      { tax_region: 'Georgia', tax_name: 'Georgia State Tax', tax_rate: '0.04', sales_taxes: '0' },
      { tax_region: 'Tennessee', tax_name: 'Tennessee State Tax', tax_rate: '0.07', sales_taxes: '90.00' },
    ],
  });
  assert.equal(f.ret.totalSales, 3747500, 'line 1 leaves out what was shipped out of state');
  assert.deepEqual(f.ret.counties.map((c) => c.name), ['Fulton', 'Cobb']);
  assert.equal(f.ret.counties[1].taxable, 50000, 'Cobb: its tax over its rate');
  assert.equal(f.ret.counties[1].code, null, 'no code the site isn’t sure of');
  assert.equal(f.ret.taxable, Math.round(148019 / 0.04), 'two counties: line 3 from the state tax');
  assert.equal(f.ret.collected, 286786 + 1000, 'line 7 is Georgia’s tax only');
  assert.ok(f.notes.some((n) => /\$90\.00 of tax for Tennessee/.test(n)));
  assert.ok(f.notes.some((n) => /\$500\.00 of sales were shipped outside Georgia/.test(n)));
});

test('a tax charged on a different amount of sales is flagged before filing', () => {
  const f = figuresFrom('2026-10', { ...SAMPLE, taxes: SAMPLE.taxes.map((t) => (t.tax_name === 'Fulton Co Tsplost Sp' ? { ...t, sales_taxes: '200.00' } : t)) });
  assert.ok(f.notes.some((n) => /Fulton Co Tsplost Sp was charged on a different amount of sales/.test(n)));
});

test('Shopify’s own sums are checked: one that doesn’t add up is flagged before filing', () => {
  const f = figuresFrom('2026-10', { ...SAMPLE, total: [{ ...SAMPLE.total[0], net_sales: '30000.00' }] });
  assert.ok(f.notes.some((n) => /don’t add up to its net sales/.test(n)));
  assert.ok(f.notes.some((n) => /don’t add up to its total sales/.test(n)));
  const days = figuresFrom('2026-10', { ...SAMPLE, days: SAMPLE.days.slice(0, 1) });
  assert.ok(days.notes.some((n) => /The days in the attached report add up to \$457\.94/.test(n)));
  assert.deepEqual(days.problems, [], 'a note, not a reason to hold the email');
});

test('a report the site can’t read is a reason not to send, never a row of zeros', () => {
  assert.match(figuresFrom('2026-10', { ...SAMPLE, total: [] }).problems.join(' '), /without the month’s totals/);
  assert.match(figuresFrom('2026-10', { ...SAMPLE, total: [{ ...SAMPLE.total[0], gross_sales: { value: '50000' } }] }).problems.join(' '), /couldn’t read as money \(gross_sales\)/);
  assert.match(figuresFrom('2026-10', { ...SAMPLE, taxes: [{ ...SAMPLE.taxes[0], tax_rate: 'n/a' }] }).problems.join(' '), /Georgia State Tax no rate/);
  assert.match(figuresFrom('2026-10', { ...SAMPLE, days: SAMPLE.days.map(({ day, ...d }) => ({ ...d, date: day })) }).problems.join(' '), /without days the site could read/);
});

// ─── What the Georgia Tax Center works out ──────────────────────────

test('the Georgia Tax Center’s own arithmetic: each line’s taxable sales times its rate, checked against the tax collected', () => {
  // A made-up month on one county: $41,000 of sales, $1,000 exempt, $40,000 taxable at 7.75%
  const oct = { totalSales: 4100000, exempt: 100000, taxable: 4000000, collected: 310000, counties: [{ name: 'Fulton', code: '060', rate: 0.0375, taxable: 4000000, tax: 150000 }] };
  const g = gtcReturn(oct);
  assert.equal(g.line3, 4000000, 'line 3: line 1 less line 2, as the Tax Center works it out');
  assert.equal(g.state.due, 160000, 'Part B line 1: 4% of taxable state sales');
  assert.equal(g.counties[0].due, 150000, 'Fulton 060: 3.75%');
  assert.equal(g.line4, 310000, 'Part A line 4');
  assert.equal(g.excess, 0, 'line 9: nothing collected beyond it');
  assert.equal(g.comp, 9000 + 50, '3% of $3,000 plus 0.5% of the $100 over');
  assert.equal(g.pay, 310000 - 9050);
  // Collected more than Georgia works out: the excess is owed too, and earns compensation
  assert.deepEqual(((x) => [x.excess, x.pay])(gtcReturn({ ...oct, collected: 310100 })), [100, 310100 - vendorComp(310100)]);
  // Collected less: Georgia's figure is owed, and the email says to check
  const short = gtcReturn({ ...oct, collected: 300000 });
  assert.equal(short.excess, -10000);
  assert.equal(short.pay, 310000 - vendorComp(310000));
  // figuresFrom pays what the Tax Center will ask for
  const s = figuresFrom('2026-10', SAMPLE);
  assert.equal(s.ret.pay, gtcReturn(s.ret).pay);
  assert.equal(s.ret.counties[0].rate, 0.0375, 'the county’s rate, rounded clean for the page');
});

// ─── The emails ──────────────────────────────────────────────────────

const LINK = 'https://admin.sunnyandranney.com/admin/sales-tax/2026-10/';

test('the 1st: a short “ready to file” email, the amount and a button, the store’s look, nothing attached', () => {
  const f = figuresFrom('2026-10', SAMPLE);
  const m = readyEmail(f, { link: LINK, replyName: 'Holly' });
  assert.equal(m.subject, 'October 2026 sales tax is ready to file');
  for (const s of [money(f.ret.pay), 'Friday, November 20', money(f.ret.comp), 'Open October’s numbers', 'reply, and it goes to Holly', 'one-time code', 'PDF and a spreadsheet']) {
    assert.ok(m.text.includes(s), `text has ${s}`);
    assert.ok(m.html.includes(esc(s)), `html has ${s}`);
  }
  assert.ok(m.html.includes(`href="${LINK}"`) && m.text.includes(LINK), 'the button goes to the month’s page');
  assert.ok(!/Line 1|Line 7|exempt/i.test(m.text + m.html), 'no return lines in the email: they’re on the page');
  assert.ok(!/—/.test(m.html + m.text), 'no em dashes');
  assert.ok(!/Check first/.test(m.html), 'nothing to check, no box');
  assert.ok(m.html.includes('#FAF7F2') && m.html.includes('#FFD400') && m.html.includes('logo-tagline-light-bg'), 'cream ground, gold, the store’s logo');
  assert.ok(m.html.includes('alt="Sunny &amp; Ranney"'));
  assert.ok(!/<script|https?:\/\/(?!imagedelivery\.net|admin\.sunnyandranney\.com)/i.test(m.html), 'no script, no other links');
  assert.match(readyEmail(f, { link: LINK }).text, /Questions: reply to this email\./, 'no reply name, no promise of one');
  const flagged = figuresFrom('2026-10', { ...SAMPLE, regions: [...SAMPLE.regions, { shipping_region: 'Tennessee', net_sales: '500.00', shipping_charges: '0' }] });
  assert.match(readyEmail(flagged, { link: LINK }).html, /Check first.*one thing to check in Shopify/s);
});

test('the reminder: not marked filed, due in so many days, the same button', () => {
  const f = figuresFrom('2026-10', SAMPLE);
  const m = reminderEmail(f, { link: LINK, daysLeft: 3, replyName: 'Holly' });
  assert.equal(m.subject, 'Reminder: October 2026 sales tax is due Friday');
  assert.match(m.text, /Georgia’s sales tax return for October is due Friday, November 20, in 3 days, and it isn’t marked filed in the store admin\./);
  assert.match(m.text, /Already filed\? Mark it filed on the page/);
  assert.ok(m.html.includes(`href="${LINK}"`));
  assert.match(reminderEmail(f, { link: LINK, daysLeft: 1 }).text, /tomorrow/);
  assert.match(reminderEmail(f, { link: LINK, daysLeft: 0 }).text, /today/);
  assert.ok(!/—/.test(m.html + m.text));
});

test('Shopify’s report, kept with the month: a spreadsheet of every day, and a two-page PDF', async () => {
  const f = figuresFrom('2026-10', SAMPLE);
  const csv = salesCsv(f).split('\r\n');
  assert.equal(csv[0], 'Day,Gross sales,Discounts,Sales reversals,Net sales,Shipping charges,Return fees,Taxes,Total sales');
  assert.equal(csv[1], '2026-10-01,600.00,-150.00,-25.00,425.00,0.00,0.00,32.94,457.94');
  assert.equal(csv[32], 'October 2026 total,50000.00,-12000.00,-25.00,37975.00,0.00,0.00,2867.86,40842.86');
  assert.ok(csv.includes('Fulton Co Tsplost Sp,Georgia,0.75%,277.57'));
  const pdf = await salesPdf(f, { readAt: NOV1_8AM });
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 2, 'the return’s lines and taxes first, then every day, as Shopify’s own report');
  assert.equal(doc.getTitle(), 'Sunny & Ranney sales October 2026');
  const flagged = figuresFrom('2026-10', { ...SAMPLE, taxes: [...SAMPLE.taxes, { tax_region: 'Georgia', tax_name: 'Cobb <b>County</b> Tax', tax_rate: '0.02', sales_taxes: '10.00' }] });
  assert.ok((await PDFDocument.load(await salesPdf(flagged))).getPageCount() >= 1, 'with notes, it still draws');
});

// ─── Shopify, faked ──────────────────────────────────────────────────

function fakeShopify({ scope = 'read_reports', deny = false, parseError = null, rows: over = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/admin/oauth/access_token')) return Response.json({ access_token: 'tok', scope, expires_in: 86399 });
    const q = JSON.parse(init.body).variables.q;
    if (deny) return Response.json({ errors: [{ message: 'Access denied for shopifyqlQuery field. Required access: `read_reports` access scope.', extensions: { code: 'ACCESS_DENIED' } }] });
    if (parseError) return Response.json({ data: { shopifyqlQuery: { tableData: null, parseErrors: [parseError] } } });
    const data = { ...SAMPLE, ...over };
    const rows = /FROM sales_taxes/.test(q) ? data.taxes : /GROUP BY day/.test(q) ? data.days : /GROUP BY shipping_region/.test(q) ? data.regions : data.total;
    const columns = Object.keys(rows[0] || {}).map((name) => ({ name, dataType: 'STRING' }));
    return Response.json({ data: { shopifyqlQuery: { tableData: { columns, rows }, parseErrors: [] } } });
  };
  return { calls, fetchImpl };
}

const ENV = (DB, extra = {}) => ({
  DB,
  SHOPIFY_CLIENT_ID: 'id',
  SHOPIFY_CLIENT_SECRET: 'secret',
  SALES_TAX_TO: 'manager@example.com',
  SALES_TAX_CC: 'owner@example.com, not an address',
  SALES_TAX_REPLY_TO: 'owner@example.com',
  SALES_TAX_ALERT_TO: 'peter@example.com',
  SALES_TAX_REPLY_NAME: 'Holly',
  EMAIL: { send: async () => ({ messageId: 'never used here' }) },
  ...extra,
});

test('Shopify: the app’s token, then ShopifyQL with it; a missing permission says how to fix it', async () => {
  const s = fakeShopify();
  const token = await shopifyToken(ENV(null), s.fetchImpl);
  assert.equal(token, 'tok');
  assert.equal(s.calls[0].url, 'https://e89vsg-er.myshopify.com/admin/oauth/access_token');
  assert.match(String(s.calls[0].init.body), /grant_type=client_credentials/);
  const rows = await shopifyql(ENV(null), token, queries('2026-10').taxes, s.fetchImpl);
  assert.equal(rows.length, 3);
  assert.equal(s.calls[1].init.headers['X-Shopify-Access-Token'], 'tok');
  assert.equal(s.calls[1].url, 'https://e89vsg-er.myshopify.com/admin/api/2026-10/graphql.json');
  assert.match(queries('2026-10').total, /SINCE 2026-10-01 UNTIL 2026-10-31$/);
  assert.match(queries('2027-02').days, /UNTIL 2027-02-28 ORDER BY day ASC$/);
  // Arrays of values (in column order) read the same as objects
  const arr = await shopifyql(ENV(null), 'tok', 'x', async () => Response.json({ data: { shopifyqlQuery: { tableData: { columns: [{ name: 'a' }, { name: 'b' }], rows: [[1, 2]] }, parseErrors: [] } } }));
  assert.deepEqual(arr, [{ a: 1, b: 2 }]);
  await assert.rejects(shopifyToken(ENV(null), fakeShopify({ scope: 'read_products' }).fetchImpl), /isn’t allowed to read reports/);
  await assert.rejects(shopifyql(ENV(null), 'tok', 'x', fakeShopify({ deny: true }).fetchImpl), /isn’t allowed to read reports/);
  await assert.rejects(shopifyql(ENV(null), 'tok', 'x', fakeShopify({ parseError: 'Column Not Found' }).fetchImpl), /couldn’t read the report: Column Not Found/);
  await assert.rejects(shopifyToken(ENV(null), async () => new Response('no', { status: 400 })), /refused the app’s keys \(HTTP 400\)\. Check SHOPIFY_CLIENT_ID/);
  // Shopify's own 400 pages, as it sends them: the reason is in the title
  const oauthPage = (code) => async () => new Response(`<!DOCTYPE html><html lang="en"><head><title>400 - Oauth error ${code}</title></head></html>`, { status: 400 });
  await assert.rejects(shopifyToken(ENV(null), oauthPage('application_cannot_be_found')), /HTTP 400, application_cannot_be_found\)\. Shopify doesn’t know the app by SHOPIFY_CLIENT_ID/);
  await assert.rejects(shopifyToken(ENV(null), oauthPage('invalid_request')), /HTTP 400, invalid_request\)\. Shopify knows the app but not SHOPIFY_CLIENT_SECRET/);
});

// ─── The monthly run ─────────────────────────────────────────────────

test('the monthly run: once, from 8 AM on the 1st, to the manager with the owner copied; the report kept with the month', async () => {
  const DB = await createD1();
  const s = fakeShopify();
  const sent = [];
  const send = async (env, m) => {
    sent.push(m);
    return { id: `em_${sent.length}` };
  };
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: NOV1_8AM - MIN, fetchImpl: s.fetchImpl, send })).why, 'before 8am on the 1st');
  assert.deepEqual(
    await salesTaxFacts(DB, { now: NOV1_8AM - MIN }),
    { due: null, dueName: null, last: null, problem: null, waiting: false, unreadable: false, toFile: null, next: { month: '2026-10', words: 'Sunday, November 1 at 8 AM' }, months: [] },
    'nothing yet, no trouble',
  );
  const r = await maybeRunSalesTax(ENV(DB), { now: NOV1_8AM, fetchImpl: s.fetchImpl, send });
  assert.deepEqual(r, { ran: true, sent: '2026-10' });
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.deepEqual(m.to, ['manager@example.com']);
  assert.deepEqual(m.cc, ['owner@example.com'], 'only real addresses copied');
  assert.equal(m.replyTo, 'owner@example.com', 'a reply goes to the owner');
  assert.equal(m.subject, 'October 2026 sales tax is ready to file');
  assert.ok(m.text.includes(monthPage('2026-10')) && m.html.includes(`href="${monthPage('2026-10')}"`), 'the button goes to October’s page');
  assert.equal(monthPage('2026-10'), 'https://admin.sunnyandranney.com/admin/sales-tax/2026-10/');
  assert.match(m.text, /reply, and it goes to Holly/);
  assert.equal(m.attachments, undefined, 'nothing attached: the report is on the page');
  // Never twice: not on the next run, not later in the month
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: NOV1_8AM + 30 * MIN, fetchImpl: s.fetchImpl, send })).why, 'sent or tried lately');
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: NOV1_8AM + 5 * 864e5, fetchImpl: s.fetchImpl, send })).why, 'sent or tried lately');
  assert.equal(sent.length, 1);
  const row = await DB.prepare('SELECT * FROM sales_tax_months').first();
  assert.equal(row.state, 'sent');
  assert.equal(row.email_id, 'em_1');
  const kept = JSON.parse(row.figures);
  assert.equal(kept.ret.collected, 286786, 'the figures sent are kept');
  assert.equal(kept.daily.length, 31, 'every day, for the page and a later PDF');
  const pdf = await monthFile(DB, '2026-10', 'pdf');
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.filename, 'Sunny & Ranney sales October 2026.pdf');
  assert.equal(Buffer.from(pdf.body.subarray(0, 5)).toString(), '%PDF-', 'the PDF as it was made, back out of D1');
  assert.equal((await PDFDocument.load(pdf.body)).getPageCount(), 2);
  assert.match((await monthFile(DB, '2026-10', 'csv')).body, /^Day,Gross sales/);
  assert.equal(await monthFile(DB, '2026-10', 'exe'), null);
  assert.equal(await monthFile(DB, '2026-09', 'pdf'), null);
  const facts = await salesTaxFacts(DB, { now: NOV1_8AM + 864e5 });
  assert.deepEqual(facts.last, { month: '2026-10', name: 'October 2026', at: new Date(NOV1_8AM).toISOString() });
  assert.equal(facts.problem, null);
  assert.equal(facts.waiting, false);
  assert.deepEqual(facts.toFile, { month: '2026-10', name: 'October 2026', due: '2026-11-20', dueWords: 'Friday, November 20', daysLeft: 18 });
  assert.deepEqual(facts.next, { month: '2026-11', words: 'Tuesday, December 1 at 8 AM' });
  assert.ok(!/@|286786|2,867/.test(JSON.stringify(facts)), 'no address or amount in the status');
  // December 1 sends November
  const november = fakeShopify({ rows: { days: SAMPLE.days.map((d) => ({ ...d, day: d.day.replace('2026-10', '2026-11') })) } });
  assert.deepEqual(await maybeRunSalesTax(ENV(DB), { now: Date.parse('2026-12-01T13:00:00Z'), fetchImpl: november.fetchImpl, send }), { ran: true, sent: '2026-11' });
  assert.equal(sent.length, 2);
});

// ─── Filing it ───────────────────────────────────────────────────────

/** A month sent, as the run leaves it */
async function sentMonth(DB, month = '2026-10') {
  const send = async () => ({ id: 'em' });
  const [y, m] = month.split('-').map(Number);
  const first = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 13);
  const rows = { days: SAMPLE.days.map((d) => ({ ...d, day: d.day.replace('2026-10', month) })) };
  await maybeRunSalesTax(ENV(DB), { now: first, fetchImpl: fakeShopify({ rows }).fetchImpl, send });
}

test('the filing page’s record: first opened, then marked filed with the confirmation number, or taken back', async () => {
  const DB = await createD1();
  await sentMonth(DB);
  const t = Date.parse('2026-11-09T15:00:00Z');
  const first = await monthRecord(DB, '2026-10', { now: t, viewer: 'staci@example.com' });
  assert.equal(first.name, 'October 2026');
  assert.equal(first.figures.ret.collected, 286786);
  assert.deepEqual(first.files, { pdf: true, csv: true });
  assert.deepEqual(first.opened, { at: new Date(t).toISOString(), by: 'staci@example.com' });
  assert.equal(first.filed, null);
  const again = await monthRecord(DB, '2026-10', { now: t + 3600e3, viewer: 'peter@example.com' });
  assert.deepEqual(again.opened, first.opened, 'the first opening only, so filing time is from then');
  assert.equal(await monthRecord(DB, '2026-09'), null, 'a month never sent has no page');
  assert.equal(await monthRecord(DB, 'nope'), null);

  assert.equal(await setFiled(DB, '2026-10', { filed: true, by: 'staci@example.com', confirmation: '  0-123-456-789  ', now: t + 6 * MIN }), true);
  const filed = await monthRecord(DB, '2026-10');
  assert.deepEqual(filed.filed, { at: new Date(t + 6 * MIN).toISOString(), by: 'staci@example.com', confirmation: '0-123-456-789' });
  const facts = await salesTaxFacts(DB, { now: t + 7 * MIN });
  assert.equal(facts.toFile, null, 'nothing left to file');
  assert.deepEqual(facts.months[0].filed, filed.filed);
  assert.equal(await setFiled(DB, '2026-10', { filed: false }), true);
  assert.equal((await monthRecord(DB, '2026-10')).filed, null, 'taken back');
  assert.equal(await setFiled(DB, '2026-09', { filed: true }), false, 'a month never sent can’t be filed');
  assert.equal(await setFiled(DB, '2026-10', { filed: true, confirmation: 'x'.repeat(200) }), true);
  assert.equal((await monthRecord(DB, '2026-10')).filed.confirmation.length, 64);
});

test('the reminder: from 8 AM three days before it’s due, once, to the store, only if not marked filed', async () => {
  const DB = await createD1();
  await sentMonth(DB);
  const sent = [];
  const send = async (env, m) => {
    sent.push(m);
    return { id: 'r' };
  };
  // Due Friday, November 20; three days before is Tuesday the 17th, 8 AM Eastern = 13:00 UTC
  const NOV17_8AM = Date.parse('2026-11-17T13:00:00Z');
  assert.equal(daysUntil('2026-11-20', NOV17_8AM), 3);
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: NOV17_8AM - MIN, send })).why, 'sent or tried lately', 'not before 8');
  assert.deepEqual(await maybeRunSalesTax(ENV(DB), { now: NOV17_8AM, send }), { ran: true, reminded: '2026-10' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Reminder: October 2026 sales tax is due Friday');
  assert.deepEqual(sent[0].to, ['manager@example.com']);
  assert.deepEqual(sent[0].cc, ['owner@example.com'], 'Holly copied');
  assert.match(sent[0].text, /in 3 days/);
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: NOV17_8AM + 30 * MIN, send })).why, 'sent or tried lately', 'once');
  assert.equal(sent.length, 1);

  // Filed before the 17th: no reminder
  const DB2 = await createD1();
  await sentMonth(DB2);
  await setFiled(DB2, '2026-10', { filed: true, now: NOV17_8AM - 864e5 });
  assert.equal((await maybeRunSalesTax(ENV(DB2), { now: NOV17_8AM, send })).why, 'sent or tried lately');
  assert.equal(sent.length, 1);

  // A reminder that doesn't go is tried again on the next run; after the due date, none
  const DB3 = await createD1();
  await sentMonth(DB3);
  const failing = async () => {
    throw new Error('E_RATE_LIMIT_EXCEEDED');
  };
  assert.equal((await maybeRunSalesTax(ENV(DB3), { now: NOV17_8AM, send: failing })).why, 'sent or tried lately');
  assert.deepEqual(await maybeRunSalesTax(ENV(DB3), { now: NOV17_8AM + 30 * MIN, send }), { ran: true, reminded: '2026-10' });
  const DB4 = await createD1();
  await sentMonth(DB4);
  assert.equal((await maybeRunSalesTax(ENV(DB4), { now: Date.parse('2026-11-21T15:00:00Z'), send })).why, 'sent or tried lately', 'past due: no reminder');
});

test('a month sent before files were kept gets them, only if Shopify still says what was sent', async () => {
  // October as it went out on November 8: the old table, figures without the days, no files
  const OLD = `CREATE TABLE sales_tax_months (
    month TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'trying', tries INTEGER NOT NULL DEFAULT 0,
    first_try_at TEXT, last_try_at TEXT, sent_at TEXT, email_id TEXT, figures TEXT, error TEXT, alerted_at TEXT)`;
  const oldMonth = async () => {
    const DB = await createD1();
    await DB.prepare(OLD).run();
    const f = figuresFrom('2026-10', SAMPLE);
    await DB.prepare("INSERT INTO sales_tax_months (month, state, tries, sent_at, figures) VALUES ('2026-10', 'sent', 4, '2026-11-08T18:00:48.201Z', ?)")
      .bind(JSON.stringify({ ...f, daily: undefined }))
      .run();
    return DB;
  };
  const DB = await oldMonth();
  await ensureTable(DB);
  const cols = ((await DB.prepare('PRAGMA table_info(sales_tax_months)').all()).results || []).map((c) => c.name);
  for (const c of ['pdf_b64', 'csv', 'opened_at', 'opened_by', 'filed_at', 'filed_by', 'confirmation', 'reminded_at']) assert.ok(cols.includes(c), `${c} added in place`);
  assert.deepEqual((await monthRecord(DB, '2026-10')).files, { pdf: false, csv: false });
  const now = Date.parse('2026-11-09T15:00:00Z');
  assert.deepEqual(await maybeRunSalesTax(ENV(DB), { now, fetchImpl: fakeShopify().fetchImpl }), { ran: true, files: 'kept' });
  assert.deepEqual((await monthRecord(DB, '2026-10')).files, { pdf: true, csv: true });
  assert.equal(JSON.parse((await DB.prepare('SELECT figures FROM sales_tax_months').first()).figures).daily.length, 31);
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: now + 30 * MIN, fetchImpl: fakeShopify().fetchImpl })).why, 'sent or tried lately', 'once');

  // Shopify has moved since (a late refund, say): no files from different numbers, and Shopify isn't asked again
  const DB2 = await oldMonth();
  const moved = fakeShopify({ rows: { taxes: SAMPLE.taxes.map((t) => ({ ...t, sales_taxes: String(Number(t.sales_taxes) - 5) })) } });
  assert.deepEqual(await maybeRunSalesTax(ENV(DB2), { now, fetchImpl: moved.fetchImpl }), { ran: true, files: 'shopify changed' });
  assert.deepEqual((await monthRecord(DB2, '2026-10')).files, { pdf: false, csv: false });
  assert.equal(await monthFile(DB2, '2026-10', 'pdf'), null);
  const calls = moved.calls.length;
  await maybeRunSalesTax(ENV(DB2), { now: now + 30 * MIN, fetchImpl: moved.fetchImpl });
  assert.equal(moved.calls.length, calls);
});

test('two runs at the same moment send one email', async () => {
  const DB = await createD1();
  const sent = [];
  const send = async (env, m) => {
    sent.push(m);
    return { id: 'em' };
  };
  const results = await Promise.all([0, 1, 2].map(() => maybeRunSalesTax(ENV(DB), { now: NOV1_8AM, fetchImpl: fakeShopify().fetchImpl, send })));
  assert.equal(results.filter((x) => x.ran).length, 1);
  assert.equal(sent.length, 1);
});

test('not set up yet: nothing sent, the admin says what’s missing', async () => {
  const DB = await createD1();
  const sent = [];
  const send = async (env, m) => {
    sent.push(m);
    return { id: 'em' };
  };
  const r = await maybeRunSalesTax(ENV(DB, { SHOPIFY_CLIENT_SECRET: undefined }), { now: NOV1_8AM, send, alert: async () => {} });
  assert.equal(r.why, 'error');
  assert.equal(sent.length, 0);
  const facts = await salesTaxFacts(DB, { now: NOV1_8AM + MIN });
  assert.match(facts.problem.error, /Shopify app’s keys .* aren’t on the sales-tax worker/);
  assert.match(setupProblem(ENV(null, { SALES_TAX_TO: '' })), /SALES_TAX_TO/);
  assert.match(setupProblem(ENV(null, { EMAIL: undefined })), /EMAIL binding/);
  assert.equal(setupProblem(ENV(null)), null);
  assert.deepEqual(await maybeRunSalesTax({}, { now: NOV1_8AM }), { ran: false, why: 'no database' });
});

test('a failure tries again every 30 minutes, tells the owner once after 2 hours, then sends', async () => {
  const DB = await createD1();
  const deny = fakeShopify({ deny: true });
  const sent = [];
  const alerts = [];
  const send = async (env, m) => {
    sent.push(m);
    return { id: 'em_ok' };
  };
  const alert = async (env, card) => {
    alerts.push(card);
  };
  const t = NOV1_8AM;
  const r1 = await maybeRunSalesTax(ENV(DB), { now: t, fetchImpl: deny.fetchImpl, send, alert });
  assert.equal(r1.why, 'error');
  assert.match(r1.error, /read reports/);
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: t + 10 * MIN, fetchImpl: deny.fetchImpl, send, alert })).why, 'sent or tried lately', 'not straight away');
  // The cron's next run can land a moment short of 30 minutes later (it did, live, on Nov 8): it still tries
  assert.equal((await maybeRunSalesTax(ENV(DB), { now: t + 30 * MIN - 500, fetchImpl: deny.fetchImpl, send, alert })).why, 'error', 'the next run tries again');
  for (let i = 1; i <= 5; i++) await maybeRunSalesTax(ENV(DB), { now: t + i * 31 * MIN, fetchImpl: deny.fetchImpl, send, alert });
  assert.equal(alerts.length, 1, 'the owner hears once');
  assert.match(alerts[0].title, /October 2026 sales tax numbers didn’t go to the store/);
  assert.match(alerts[0].detail, /read reports/);
  const facts = await salesTaxFacts(DB, { now: t + 3 * 3600e3 });
  assert.equal(facts.problem.month, '2026-10');
  assert.match(facts.problem.error, /read reports/);
  assert.equal(facts.problem.tries, 6);
  // Fixed: the next try sends
  const r2 = await maybeRunSalesTax(ENV(DB), { now: t + 4 * 3600e3, fetchImpl: fakeShopify().fetchImpl, send, alert });
  assert.deepEqual(r2, { ran: true, sent: '2026-10' });
  assert.equal(sent.length, 1);
  assert.equal((await salesTaxFacts(DB, { now: t + 5 * 3600e3 })).problem, null);
  // A send that fails is a failure too
  const DB2 = await createD1();
  const r3 = await maybeRunSalesTax(ENV(DB2), {
    now: t,
    fetchImpl: fakeShopify().fetchImpl,
    send: async () => {
      throw new Error('The email didn’t send: E_SENDER_NOT_VERIFIED: domain not onboarded');
    },
    alert,
  });
  assert.match(r3.error, /E_SENDER_NOT_VERIFIED/);
});

test('Shopify’s report read wrong: no email, and the reason is kept', async () => {
  const DB = await createD1();
  const sent = [];
  const r = await maybeRunSalesTax(ENV(DB), {
    now: NOV1_8AM,
    fetchImpl: fakeShopify({ rows: { total: [{ ...SAMPLE.total[0], taxes: { value: 'x' } }] } }).fetchImpl,
    send: async (env, m) => {
      sent.push(m);
      return { id: 'em' };
    },
    alert: async () => {},
  });
  assert.equal(sent.length, 0);
  assert.match(r.error, /couldn’t read as money \(taxes\)\. Nothing was sent\./);
});

test('Cloudflare’s email binding: from the store’s sending address, its id kept, its refusal in words', async () => {
  let got;
  const env = { EMAIL: { send: async (m) => ((got = m), { messageId: 'cf_1' }) } };
  assert.deepEqual(await sendWithBinding(env, { to: ['a@example.com'], subject: 's', text: 't' }), { id: 'cf_1' });
  assert.deepEqual(got.from, FROM);
  assert.equal(FROM.email, 'reports@mail.sunnyandranney.com');
  const refusing = { EMAIL: { send: async () => { throw Object.assign(new Error('Sender domain not verified'), { code: 'E_SENDER_NOT_VERIFIED' }); } } };
  await assert.rejects(sendWithBinding(refusing, { to: ['a@example.com'], subject: 's', text: 't' }), /The email didn’t send: E_SENDER_NOT_VERIFIED: Sender domain not verified/);
});

test('the alert goes by the same binding to the owner only, with a link to the admin page', async () => {
  const DB = await createD1();
  const out = [];
  const env = ENV(DB, { SHOPIFY_CLIENT_SECRET: undefined, EMAIL: { send: async (m) => (out.push(m), { messageId: 'a' }) } });
  await maybeRunSalesTax(env, { now: NOV1_8AM });
  await maybeRunSalesTax(env, { now: NOV1_8AM + 2 * 3600e3 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].to, ['peter@example.com']);
  assert.match(out[0].subject, /October 2026 sales tax numbers didn’t go to the store/);
  assert.match(out[0].text, /admin\.sunnyandranney\.com\/admin\/sales-tax\//);
  assert.ok(out[0].html.startsWith('<p>The store admin couldn’t send the store its Georgia sales tax numbers for October 2026: The Shopify app’s keys'));
});

test('the store’s Tax Center sign-in details: saved once, read back, never a password', async () => {
  const DB = await createD1();
  assert.deepEqual(await taxCenterLogin(DB), { username: '', stn: '', codeNote: '', updatedAt: null, updatedBy: null }, 'nothing saved yet');
  const t = Date.parse('2026-11-09T15:00:00Z');
  assert.deepEqual(await saveTaxCenterLogin(DB, { username: '  storeuser ', stn: ' 123-456789 ', codeNote: 'Staci’s phone,   authenticator app', by: 'peter@example.com', now: t }), { ok: true });
  assert.deepEqual(await taxCenterLogin(DB), { username: 'storeuser', stn: '123-456789', codeNote: 'Staci’s phone, authenticator app', updatedAt: new Date(t).toISOString(), updatedBy: 'peter@example.com' });
  assert.match((await saveTaxCenterLogin(DB, { username: 'two words' })).error, /no spaces/);
  assert.match((await saveTaxCenterLogin(DB, { username: 'x', stn: '12;drop' })).error, /digits and dashes/);
  assert.match((await saveTaxCenterLogin(DB, { username: 'x', codeNote: 'Pass: ask Staci' })).error, /Don’t save the password here/);
  assert.equal((await taxCenterLogin(DB)).username, 'storeuser', 'a refused save changes nothing');
  assert.deepEqual(await saveTaxCenterLogin(DB, { username: '', stn: '', codeNote: '' }), { ok: true }, 'cleared');
  assert.equal((await taxCenterLogin(DB)).username, '');
  assert.equal(TAX_CENTER, 'https://gtc.dor.ga.gov/_/', 'the address that loads (the bare one answers 404)');
});

// ─── What the review found (2026-11-08), each fixed and kept fixed ──

test('the state’s 4% is found under the names Shopify uses, and without it nothing is sent', () => {
  for (const name of ['Georgia State Tax', 'GA State Tax', 'State Tax', 'Georgia Sales Tax']) {
    const f = figuresFrom('2026-10', { ...SAMPLE, taxes: SAMPLE.taxes.map((t) => (t.tax_name === 'Georgia State Tax' ? { ...t, tax_name: name } : t)) });
    assert.equal(f.ret.taxable, Math.round(286786 / 0.0775), `${name} is the state’s line`);
    assert.deepEqual(f.problems, [], name);
  }
  const local = figuresFrom('2026-10', { ...SAMPLE, taxes: SAMPLE.taxes.filter((t) => t.tax_name !== 'Georgia State Tax') });
  assert.match(local.problems.join(' '), /no state line the site recognizes \(Fulton County Tax, Fulton Co Tsplost Sp\)/, 'local taxes alone: no numbers to file from');
});

/** A real D1 whose writes matching `pattern` fail the first `times` times */
function flaky(DB, pattern, times = 1) {
  let left = times;
  return new Proxy(DB, {
    get(target, key) {
      if (key !== 'prepare') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return (sql) => {
        const stmt = target.prepare(sql);
        if (!pattern.test(sql)) return stmt;
        const wrap = (s) => ({ bind: (...a) => wrap(s.bind(...a)), first: (...a) => s.first(...a), all: (...a) => s.all(...a), run: async (...a) => { if (left > 0) { left--; throw new Error('D1_ERROR: network connection lost'); } return s.run(...a); } });
        return wrap(stmt);
      };
    },
  });
}

test('the email gone but the save failing: the month is still sent, and never emailed twice', async () => {
  const DB = await createD1();
  const sent = [];
  const send = async (env, m) => (sent.push(m), { id: 'em_1' });
  const env = ENV(flaky(DB, /pdf_b64 = \?, csv = \?, error = NULL/));
  assert.deepEqual(await maybeRunSalesTax(env, { now: NOV1_8AM, fetchImpl: fakeShopify().fetchImpl, send }), { ran: true, sent: '2026-10' });
  const row = await DB.prepare('SELECT state, email_id, figures FROM sales_tax_months').first();
  assert.equal(row.state, 'sent', 'marked sent the plain way');
  assert.equal(row.email_id, 'em_1');
  assert.equal(JSON.parse(row.figures).ret.collected, 286786, 'the figures still kept');
  await maybeRunSalesTax(ENV(DB), { now: NOV1_8AM + 30 * MIN, fetchImpl: fakeShopify().fetchImpl, send });
  assert.equal(sent.length, 1, 'not sent again');
});

test('the owner’s alert that fails to send is tried again, not marked done', async () => {
  const DB = await createD1();
  const env = ENV(DB, { SHOPIFY_CLIENT_SECRET: undefined });
  const tries = [];
  const failing = async (e, card) => { tries.push(card); throw new Error('E_RATE_LIMIT_EXCEEDED'); };
  await maybeRunSalesTax(env, { now: NOV1_8AM, alert: failing });
  await maybeRunSalesTax(env, { now: NOV1_8AM + 2 * 3600e3, alert: failing });
  assert.equal(tries.length, 1);
  assert.equal((await DB.prepare('SELECT alerted_at FROM sales_tax_months').first()).alerted_at, null, 'not marked: it didn’t go');
  const ok = [];
  await maybeRunSalesTax(env, { now: NOV1_8AM + 2.5 * 3600e3, alert: async (e, card) => { ok.push(card); } });
  assert.equal(ok.length, 1, 'the next run tells the owner');
  await maybeRunSalesTax(env, { now: NOV1_8AM + 3 * 3600e3, alert: async (e, card) => { ok.push(card); } });
  assert.equal(ok.length, 1, 'once');
});

test('a month still not sent when the next comes due is tried after it, and the admin keeps showing it', async () => {
  const DB = await createD1();
  const sent = [];
  const send = async (env, m) => (sent.push(m.subject), { id: 'em' });
  await maybeRunSalesTax(ENV(DB, { SHOPIFY_CLIENT_SECRET: undefined }), { now: NOV1_8AM, alert: async () => {} });
  const DEC1 = Date.parse('2026-12-01T13:00:00Z');
  const facts = await salesTaxFacts(DB, { now: DEC1 - 864e5 });
  assert.equal(facts.problem.month, '2026-10');
  // December 1, keys fixed: November goes, then October, late
  const both = fakeShopify({ rows: {} });
  const nov = { days: SAMPLE.days.map((d) => ({ ...d, day: d.day.replace('2026-10', '2026-11') })) };
  const byMonth = async (url, init = {}) => {
    let q = '';
    try {
      q = JSON.parse(init.body).variables?.q || '';
    } catch {
      /* the token request is a form, not JSON */
    }
    return (/2026-11/.test(q) ? fakeShopify({ rows: nov }) : both).fetchImpl(url, init);
  };
  const r = await maybeRunSalesTax(ENV(DB), { now: DEC1, fetchImpl: byMonth, send });
  assert.equal(r.sent, '2026-11');
  assert.deepEqual(r.older, [{ month: '2026-10', ran: true, sent: '2026-10' }]);
  assert.deepEqual(sent, ['November 2026 sales tax is ready to file', 'October 2026 sales tax is ready to file']);
  // A month three back is left alone
  const DB2 = await createD1();
  await DB2.prepare(SCHEMA_SQL).run();
  await DB2.prepare("INSERT INTO sales_tax_months (month, state, tries, error) VALUES ('2026-08', 'failed', 3, 'x')").run();
  assert.equal((await maybeRunSalesTax(ENV(DB2), { now: DEC1, fetchImpl: byMonth, send })).older, undefined);
});

test('the admin says when it can’t read the records, instead of “goes out within 30 minutes”', async () => {
  const broken = { prepare: () => ({ bind() { return this; }, run: async () => { throw new Error('D1_ERROR'); }, all: async () => { throw new Error('D1_ERROR'); }, first: async () => { throw new Error('D1_ERROR'); } }) };
  const facts = await salesTaxFacts(broken, { now: NOV1_8AM + 864e5 });
  assert.equal(facts.unreadable, true);
  assert.equal(facts.waiting, false);
});

test('the worker and the admin upgrading the table at the same moment both succeed', async () => {
  const DB = await createD1();
  await DB.prepare(`CREATE TABLE sales_tax_months (month TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'trying', tries INTEGER NOT NULL DEFAULT 0,
    first_try_at TEXT, last_try_at TEXT, sent_at TEXT, email_id TEXT, figures TEXT, error TEXT, alerted_at TEXT)`).run();
  // Two handles on one database, as the worker and the admin are
  const a = new Proxy(DB, { get: (t, k) => (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const b = new Proxy(DB, { get: (t, k) => (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  await Promise.all([ensureTable(a), ensureTable(b)]);
  const cols = ((await DB.prepare('PRAGMA table_info(sales_tax_months)').all()).results || []).map((c) => c.name);
  assert.ok(cols.includes('reminded_at') && cols.includes('pdf_b64'));
});

test('due-date words, said the same on every page', () => {
  assert.deepEqual([12, 1, 0, -1, -3].map(daysLeftWords), ['12 days left', 'Due tomorrow', 'Due today', '1 day late', '3 days late']);
});
