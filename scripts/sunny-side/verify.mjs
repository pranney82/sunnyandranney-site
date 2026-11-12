// Holds every built email to the standard: two engines (Chromium for Gmail/Outlook.com/Android,
// WebKit for Apple Mail), three widths, plus a Gmail-style render with the web font blocked.
// Fails loudly on: horizontal overflow, any off-brand color (the store's palette everywhere but the
// mission band, which is held to the charity's), links under 44px, missing alt,
// broken images, heading order, duplicate tracked links, HTML codes showing as text, text spilling
// out of its box, a product without its name and price or with a name over two lines, anything off
// the grid (photo rows run
// the full 600px or sit on the 536px column; cards and the words that start a row sit on the
// column), a phone render whose sale button lands below the first screen, CSS that Gmail strips
// (these renders load the raw file, so a layout that leans on stripped CSS would pass here and
// break in the inbox), and any image with dark artwork on a transparent background (Gmail and
// Outlook darken backgrounds in dark mode but never images, so that artwork vanishes).
import { chromium, webkit } from 'playwright';
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('./out/', import.meta.url).pathname;
const dirs = [root, join(root, 'tests')].filter(existsSync);
const files = dirs.flatMap(d => readdirSync(d).filter(f => f.endsWith('.html')).map(f => join(d, f)));
// About what Apple Mail and the Gmail app show of an email on a 390px iPhone before any scrolling,
// below their own bars (852pt screen less roughly 250pt of the app's own bars).
const FIRST_SCREEN = 600;
// The charity's palette, as sunshineonaranneyday.com renders it, allowed only inside its section (.soard):
// Sunshine Yellow, SOARD Dark, Dark Deep, Warm Gray, its muted text, and white.
const CHARITY = ['rgb(255, 218, 36)', 'rgb(55, 58, 54)', 'rgb(30, 31, 37)', 'rgb(245, 244, 240)', 'rgb(90, 91, 97)', 'rgb(255, 255, 255)'];
const BRAND = ['rgb(255, 212, 0)', 'rgb(75, 149, 180)', 'rgb(43, 122, 150)', 'rgb(44, 44, 44)', 'rgb(107, 107, 104)', 'rgb(255, 255, 255)'];
const runs = [
  { e: 'webkit', n: 'iphone-se', w: 320 }, { e: 'webkit', n: 'iphone', w: 390 }, { e: 'chromium', n: 'android', w: 390 },
  { e: 'chromium', n: 'desktop', w: 700 },
  // Gmail as it serves the email: no web font, and the CSS it strips is gone.
  { e: 'chromium', n: 'gmail-web', w: 700, gmail: true }, { e: 'chromium', n: 'gmail-app', w: 390, gmail: true },
];
mkdirSync(join(root, 'shots'), { recursive: true });
const engines = { chromium: await chromium.launch(), webkit: await webkit.launch() };
// Declarations Gmail removes from inline styles: negative margins, positioning, flex and grid.
const GMAIL_STRIPS = /(?:margin[a-z-]*\s*:[^;"]*-\d[^;"]*|position\s*:[^;"]*|display\s*:\s*(?:inline-)?(?:flex|grid)[^;"]*);?/gi;

/**
 * Images that would lose their dark parts in dark mode: more than 1% transparent and more than 0.5%
 * dark opaque pixels (a logo's lettering). An image must be opaque, or light enough for any background.
 */
async function darkOnTransparent(html) {
  const urls = [...new Set([...html.matchAll(/<img[^>]*\bsrc="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&')))];
  const page = await engines.chromium.newPage();
  const bad = await page.evaluate(async (urls) => {
    const out = [];
    for (const u of urls) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = u;
      try { await img.decode(); } catch { continue; } // a broken image fails its own check
      const k = Math.min(1, 200 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, c.width, c.height);
      let d;
      try { d = g.getImageData(0, 0, c.width, c.height).data; } catch { out.push(`can't read the pixels of ${u.slice(0, 70)}`); continue; }
      let clear = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 250) clear++;
        else if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 110) dark++;
      }
      const n = d.length / 4;
      if (clear / n > 0.01 && dark / n > 0.005) out.push(`${u.split('/').slice(-3).join('/').slice(0, 70)} is ${Math.round((dark / n) * 100)}% dark artwork on a transparent background`);
    }
    return out;
  }, urls);
  await page.close();
  return bad;
}
let failures = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const stripped = [...new Set(src.match(GMAIL_STRIPS) || [])];
  if (stripped.length) { failures++; console.log(`FAIL  ${f.split('/').pop()}  Gmail strips: ${stripped.join(' | ')}`); }
  const darkMode = await darkOnTransparent(src);
  if (darkMode.length) { failures++; console.log(`FAIL  ${f.split('/').pop()}  dark mode: ${darkMode.join(' | ')}`); }
  for (const r of runs) {
    const ctx = await engines[r.e].newContext({ viewport: { width: r.w, height: 844 }, deviceScaleFactor: r.w < 600 ? 2 : 1 });
    if (r.gmail) await ctx.route(/fonts\.(googleapis|gstatic)\.com/, x => x.abort());
    const page = await ctx.newPage();
    const failed = [];
    page.on('response', x => { if (x.status() >= 400) failed.push(x.status() + ' ' + x.url().slice(0, 70)); });
    if (r.gmail) await page.setContent(src.replace(GMAIL_STRIPS, ''), { waitUntil: 'networkidle' });
    else await page.goto('file://' + f, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Decode every image first, so the full-page screenshot shows what a reader would see.
    await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
    const m = await page.evaluate(([brand, charity]) => {
      const B = new Set(brand), C = new Set(charity), off = {};
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el), rc = el.getBoundingClientRect();
        if (!rc.width || !rc.height || el.closest('[style*="display:none"]')) continue;
        const props = ['backgroundColor'];
        if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) props.push('color');
        for (const s of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(cs['border' + s + 'Width']) > 0) props.push('border' + s + 'Color');
        const allowed = el.closest('.soard') ? C : B;
        for (const k of props) { const v = cs[k]; if (v && !v.startsWith('rgba(0, 0, 0, 0)') && !allowed.has(v)) off[v] = (off[v] || 0) + 1; }
      }
      const links = [...document.querySelectorAll('a[href]')];
      const small = links.filter(a => { const q = a.getBoundingClientRect(); return q.height > 0 && q.height < 44; }).map(a => (a.textContent.trim() || '[img]').slice(0, 18));
      const hrefs = links.map(a => a.getAttribute('href')).filter(h => !/unsubscribe|^tel:|^#/.test(h));
      const dupes = [...new Set(hrefs.filter((h, i) => hrefs.indexOf(h) !== i))];
      const heads = [...document.querySelectorAll('h1,h2,h3')].map(h => h.tagName);
      const offer = links.find(a => /utm_content=offer-button/.test(a.getAttribute('href')));

      // The column: 600px email, 32px sides (20px on phones, matching the 620px media query).
      const box = document.querySelector('table[style*="max-width:600px"]').getBoundingClientRect();
      const inset = innerWidth <= 620 ? 20 : 32, L = box.left + inset, R = box.right - inset, near = (a, b) => Math.abs(a - b) <= 1;
      // A card is a rounded, filled cell (the event spotlight). Buttons are rounded and filled too, but aren't cards.
      const isCard = el => el.tagName === 'TD' && !el.closest('table.btn') && parseFloat(getComputedStyle(el).borderTopLeftRadius) >= 12
        && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)';
      const inCard = el => { for (let a = el.parentElement; a; a = a.parentElement) if (isCard(a)) return true; return false; };
      // Photo rows and card rows start and end on the column, or (photos) run the full email width.
      // The logo and small marks (the pig, Greg) are exempt.
      const blocks = [...document.images].filter(i => {
        const q = i.getBoundingClientRect(); return q.width >= 120 && !/(^|\s)(soard-)?logo(\s|$)/.test(i.className);
      }).concat([...document.querySelectorAll('td')].filter(isCard));
      const byRow = {};
      for (const el of blocks) { const q = el.getBoundingClientRect(); if (q.width) (byRow[Math.round(q.top + scrollY)] ||= []).push(q); }
      const drift = [], col = x => Math.round(x - box.left);
      for (const [y, rs] of Object.entries(byRow)) {
        rs.sort((a, b) => a.left - b.left);
        const l = rs[0].left, r = rs.at(-1).right;
        const onColumn = near(l, L) && near(r, R), fullBleed = near(l, box.left) && near(r, box.right);
        if (!onColumn && !fullBleed) drift.push(`row@${y} ${col(l)}-${col(r)}`);
      }
      // Left-aligned words that start a row (not a second column: a tier, an event's "what") and sit
      // outside cards start on the column.
      const startsRow = el => { const td = el.closest('td'); return !td || !td.previousElementSibling; };
      for (const t of document.querySelectorAll('p,h1,h2,.tile-name,.tile-price')) {
        const q = t.getBoundingClientRect(), a = getComputedStyle(t).textAlign;
        if (q.width && (a === 'left' || a === 'start') && !inCard(t) && startsRow(t) && !near(q.left, L))
          drift.push(`"${t.textContent.trim().slice(0, 16)}"@${col(q.left)}`);
      }
      // Text that spills out of its own box: into a neighbor's padding, a rule, or off the email.
      const spill = [...document.querySelectorAll('p,h1,h2,.tile-name,.tile-price')].filter(t => t.getBoundingClientRect().width && t.scrollWidth > t.clientWidth + 1)
        .map(t => `"${t.textContent.trim().slice(0, 12)}"`);
      // HTML codes that ended up as visible text (an escaped or mangled &nbsp;, &amp;, &#8594; ...).
      const codes = [...new Set(document.body.innerText.match(/&[a-z]+;|&#x?[0-9a-f]+;/gi) || [])];
      // Every product on the wall is shoppable at a glance: one link with its name and price, and the
      // name fits two lines.
      const tiles = links.filter(a => /utm_content=wall-\d/.test(a.getAttribute('href')));
      const unlabeled = tiles.filter(a => !a.querySelector('.tile-name')?.textContent.trim() || !a.querySelector('.tile-price')?.textContent.trim()).length;
      const longNames = tiles.map(a => a.querySelector('.tile-name')).filter(n => n && n.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(n).lineHeight) + 1)
        .map(n => `"${n.textContent.trim().slice(0, 20)}"`);
      return {
        unlabeled, longNames,
        spill, codes,
        misaligned: drift,
        h: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth, off,
        small, dupes, noAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
        broken: [...document.images].filter(i => !i.naturalWidth).length,
        headingsOk: heads.filter(x => x === 'H1').length === 1 && heads[0] === 'H1',
        offerY: offer ? Math.round(offer.getBoundingClientRect().bottom + scrollY) : null,
      };
    }, [BRAND, CHARITY]);
    const name = f.split('/').pop().replace('.html', '');
    await page.screenshot({ path: join(root, 'shots', `${name}.${r.n}.png`), fullPage: true });
    const problems = [m.overflow && 'overflow', Object.keys(m.off).length && 'off-brand ' + JSON.stringify(m.off),
      m.small.length && 'small ' + m.small, m.dupes.length && 'duplicate links ' + m.dupes.length, m.noAlt && 'no alt',
      m.broken && 'broken images', !m.headingsOk && 'heading order', failed.length && 'failed ' + failed,
      m.misaligned.length && 'off the grid ' + m.misaligned.join(' '),
      m.codes.length && 'HTML codes showing as text ' + m.codes.join(' '),
      m.spill.length && 'text spilling out of its box ' + m.spill.join(' '),
      m.unlabeled && `${m.unlabeled} products without a name and price`,
      m.longNames.length && 'product names over two lines ' + m.longNames.join(' '),
      r.w < 600 && m.offerY > FIRST_SCREEN && `sale button below the first screen (${m.offerY}px)`,
      m.offerY === null && 'no sale button'].filter(Boolean);
    if (problems.length) failures++;
    console.log(`${problems.length ? 'FAIL' : 'pass'}  ${name.padEnd(34)} ${r.n.padEnd(14)} ${(m.h / 700).toFixed(2)} screens  sale button ${m.offerY ?? '-'}px  ${problems.join('; ')}`);
    await ctx.close();
  }
}
for (const b of Object.values(engines)) await b.close();
console.log(failures ? `\n${failures} failing renders` : '\nall renders pass');
process.exit(failures ? 1 : 0);
