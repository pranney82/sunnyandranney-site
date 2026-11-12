// Builds the weekly email from its brief: node scripts/sunny-side/build.mjs [--local] [brief.json ...]
// With no briefs named, every brief in briefs/ goes to out/ and every stress test in tests/ to out/tests/,
// which verify.mjs then holds to the standard. The email itself is src/lib/sunny-side/email.mjs, the
// same code the admin uses to preview the week's special.
//
// A brief whose "sale" is "admin" takes the special Staci saved at /admin/special/ for its send date,
// read from the store's D1 database with wrangler (--local reads the local dev database instead).
// A brief whose mission "impact" is "live" takes the charity's impact numbers from its own site,
// where its records keep them current.
// Every photo-wall product is read from its own page on sunnyandranney.com (name, price, photo) and
// its stock from the shop's own count, so the email shows what the store shows today and never a
// product it doesn't have.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { lines, render } from '../../src/lib/sunny-side/email.mjs';
import { check, clean, isSendDate, sendLabel, toSale } from '../../src/lib/sunny-side/special.mjs';
import { IMPACT_PAGE, impactFromPage } from '../../src/lib/sunny-side/impact.mjs';
import { NAME_MAX, displayName, handleOf, isProductPage, photoFor, productFromPage, quantitiesFromShop } from '../../src/lib/sunny-side/product.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..', '..');
const args = process.argv.slice(2);
const local = args.includes('--local');
const briefs = args.filter((a) => a !== '--local');

/** The special Staci saved for a send date, as the email's offer. */
function specialFromAdmin(send) {
  if (!isSendDate(send)) throw new Error(`send_date ${send} isn't a Tuesday, so the admin has no special for it.`);
  const missing = `No special is saved for the ${sendLabel(send)} email yet. Staci sets it at admin.sunnyandranney.com/admin/special/.`;
  let out;
  try {
    out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'sunnyandranney-db', local ? '--local' : '--remote', '--json', '--command', `SELECT special FROM email_specials WHERE send_date = '${send}'`],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // The table only exists once a first special is saved
    if (/no such table/i.test(String(err.stdout) + String(err.stderr))) throw new Error(missing);
    throw new Error(`Couldn't read the admin's database with wrangler: ${String(err.stderr || err.message).trim()}`);
  }
  const rows = JSON.parse(out)[0]?.results ?? [];
  if (!rows.length) throw new Error(missing);
  const special = clean(JSON.parse(rows[0].special));
  const problems = Object.values(check(special, send));
  if (problems.length) throw new Error(`The ${sendLabel(send)} special needs fixing in the admin: ${problems.join(' ')}`);
  return toSale(special);
}

let impact = null;
/** Sunshine on a Ranney Day's room makeovers and children served, as its brand page shows them today. */
async function liveImpact() {
  if (impact) return impact;
  try {
    const res = await fetch(IMPACT_PAGE, { headers: { 'User-Agent': 'sunny-side-build' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`it answered ${res.status}.`);
    impact = impactFromPage(await res.text());
    return impact;
  } catch (err) {
    throw new Error(`Couldn't read the charity's impact numbers from ${IMPACT_PAGE}: ${err.message}`);
  }
}

const SHOP = 'https://sunnyandranney.com/shop/';
const text = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Each wall product filled from its own page on sunnyandranney.com, where it can be bought: its name
 * (cleaned for customers, unless the brief gives a short one), its price, its photo (unless the brief
 * picks one), and a stock check. Every problem is listed at once, and any problem stops the build.
 * Prices always come from the store. Only the stress tests in tests/ bring their own name and price,
 * so they run offline; a real brief that names a price is stopped, so it can't skip the stock check.
 */
async function productsFromStore(photos, { fixed }) {
  if (fixed) return photos;
  const problems = [];
  let stock;
  try {
    const res = await fetch(SHOP, { headers: { 'User-Agent': 'sunny-side-build' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`it answered ${res.status}.`);
    stock = quantitiesFromShop(await res.text());
  } catch (err) {
    throw new Error(`Couldn't read stock from ${SHOP}: ${err.message}`);
  }
  const filled = await Promise.all(
    photos.map(async (ph, k) => {
      if ('price' in ph) {
        problems.push(`Product ${k + 1} gives its own "price". Take it out: the price comes from the store, with the stock check.`);
        return ph;
      }
      if (!isProductPage(ph.url || '')) {
        problems.push(`Product ${k + 1} needs its page on sunnyandranney.com/shop/ as its "url".`);
        return ph;
      }
      let p;
      try {
        const res = await fetch(ph.url, { headers: { 'User-Agent': 'sunny-side-build' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`it answered ${res.status}.`);
        p = productFromPage(await res.text());
      } catch (err) {
        problems.push(`Couldn't read ${ph.url}: ${err.message}`);
        return ph;
      }
      const name = ph.name || text(displayName(p.name));
      const qty = stock.get(handleOf(ph.url));
      if (qty === undefined) problems.push(`${name} isn't listed in the shop, so its stock can't be checked. Pick another product.`);
      else if (qty <= 0 || !p.inStock) problems.push(`${name} is out of stock (${qty} in the shop). Pick another product.`);
      if (!ph.name && name.length > NAME_MAX) problems.push(`"${name}" is too long for a tile (${name.length} characters, ${NAME_MAX} at most). Give it a short "name".`);
      const src = ph.src || photoFor(p.images);
      if (!src) problems.push(`${name} has only PNG photos, which are too heavy for email. Give it a "src" photo.`);
      return { ...ph, name, price: p.price, src };
    }),
  );
  if (problems.length) throw new Error(`The photo wall needs fixing:\n- ${problems.join('\n- ')}`);
  return filled;
}

/** Builds one brief. Its old email goes first, so a brief that can't be built leaves nothing for verify.mjs to pass. */
async function build(path, out) {
  mkdirSync(out, { recursive: true });
  const name = basename(path, '.json');
  rmSync(join(out, `${name}.html`), { force: true });
  const brief = JSON.parse(readFileSync(path, 'utf8'));
  if (brief.sale === 'admin') brief.sale = specialFromAdmin(brief.send_date);
  if (brief.mission?.impact === 'live') brief.mission.impact = await liveImpact();
  const fixed = !relative(join(HERE, 'tests'), path).startsWith('..');
  if (brief.wall?.photos) brief.wall.photos = await productsFromStore(brief.wall.photos, { fixed });
  const html = render(brief);
  writeFileSync(join(out, `${name}.html`), html);
  console.log('built', join(relative(HERE, out), name), '·', lines(brief).subject);
}

// Every brief is tried, so one waiting on the admin doesn't hold up the rest; any that fail are
// listed at the end and the build exits 1. With no briefs named, emails whose brief is gone go too.
const failed = [];
async function attempt(path, out) {
  try {
    await build(path, out);
  } catch (err) {
    failed.push(`${relative(HERE, path)}: ${err.message}`);
  }
}
if (briefs.length) {
  for (const path of briefs) await attempt(path, join(HERE, 'out'));
} else {
  for (const [folder, out] of [['briefs', join(HERE, 'out')], ['tests', join(HERE, 'out', 'tests')]]) {
    const files = readdirSync(join(HERE, folder)).filter((f) => f.endsWith('.json')).sort();
    const current = new Set(files.map((f) => `${basename(f, '.json')}.html`));
    mkdirSync(out, { recursive: true });
    for (const old of readdirSync(out).filter((f) => f.endsWith('.html') && !current.has(f))) rmSync(join(out, old));
    for (const file of files) await attempt(join(HERE, folder, file), out);
  }
}
if (failed.length) {
  console.error(`\nNot built:\n${failed.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
