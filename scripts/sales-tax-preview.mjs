/**
 * See a month's sales tax email before it goes, or again after. Never sends.
 *
 *   node scripts/sales-tax-preview.mjs --env-file <file> [--month 2026-10] [--out <folder>]
 *
 * Reads the month from Shopify with the app keys in the env file
 * (SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET; any app with read_reports), prints
 * the filing page's lines (with what the Georgia Tax Center will work out)
 * and anything to check, and writes the "ready to file" email (HTML and text),
 * the PDF and the spreadsheet to the folder. The month defaults to the
 * one due now. The folder defaults to one in the system temp folder: the
 * figures are the store's, so keep them out of the repo.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dueDate, dueMonth, gtcReturn, money, monthName, readMonth } from '../src/lib/sales-tax/figures.mjs';
import { readyEmail, salesCsv, salesPdf } from '../src/lib/sales-tax/report.mjs';
import { monthPage } from '../src/lib/sales-tax/run.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const envFile = opt('env-file');
if (!envFile) {
  console.error('Usage: node scripts/sales-tax-preview.mjs --env-file <file with SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET> [--month YYYY-MM] [--out <folder>]');
  process.exit(1);
}
const month = opt('month') || dueMonth(Date.now()) || dueMonth(Date.now() - 864e5);
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
  console.error(`Not a month: ${month}. Use YYYY-MM.`);
  process.exit(1);
}
const out = opt('out') || join(tmpdir(), `sales-tax-preview-${month}`);

const vars = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const env = { SHOPIFY_CLIENT_ID: vars.SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET: vars.SHOPIFY_CLIENT_SECRET };
if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
  console.error(`${envFile} has no SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.`);
  process.exit(1);
}

const f = await readMonth(env, month);
const m = readyEmail(f, { link: monthPage(month), replyName: 'Holly' });
const filename = `Sunny & Ranney sales ${monthName(month)}`;
const pdf = await salesPdf(f);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'email.html'), m.html);
writeFileSync(join(out, 'email.txt'), `Subject: ${m.subject}\n\n${m.text}\n`);
writeFileSync(join(out, `${filename}.pdf`), pdf);
writeFileSync(join(out, `${filename}.csv`), salesCsv(f));

const r = f.ret;
const g = gtcReturn(r);
console.log(m.subject);
console.log(`  Line 1, total state sales         ${money(r.totalSales)}`);
console.log(`  Line 2, total exempt state sales  ${money(r.exempt)}`);
console.log(`  Line 7, tax collected             ${money(r.collected)}`);
console.log(`  Part B, Georgia 000               ${money(g.state.taxable)}  (tax ${money(g.state.due)})`);
for (const c of g.counties) console.log(`  Part B, ${c.name} ${c.code ?? '???'}`.padEnd(36) + `${money(c.taxable)}  (tax ${money(c.due)})`);
console.log(`  Tax Center: line 4 ${money(g.line4)}, line 9 ${money(Math.max(g.excess, 0))}, line 10 ${money(g.comp)}, line 13 ${money(g.pay)}`);
console.log(`  Due by ${dueDate(month).words}`);
for (const n of f.notes) console.log(`  Check: ${n}`);
for (const p of f.problems) console.log(`  WOULD NOT SEND: ${p}`);
console.log(`Written to ${out}`);
