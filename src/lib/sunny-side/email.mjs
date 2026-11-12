/**
 * The Sunny Side: the store's weekly email (production design: "Sunny", option B)
 * ===========================================================================
 * One weekly brief in, one Kit-ready email out. The same code builds the email
 * for sending (scripts/sunny-side/build.mjs) and draws the live preview Staci
 * sees while she types the week's special in the admin, so the preview is the
 * email. No Node or browser APIs, so it runs in both.
 *
 *   the photographer's photos -> brief.hero, brief.story.photo
 *   the store's products      -> brief.wall.photos (4-9), read live from their pages by the build
 *   Staci's special           -> brief.sale    kind: "tiers" (2-4) | "percent" | "headline"
 *   Staci's events            -> brief.events  each with dated items; past dates drop out, and the
 *                                                line under the title is written from the dates left
 *   the latest reveal         -> brief.mission
 *
 * Design: bold color blocks and edge-to-edge photos, like a bright weekly flyer.
 *   Rhythm: a photo always sits directly on top of the block it belongs to (the hero on the gold
 *           offer), and white space separates a photo from any block it doesn't belong to, so
 *           nothing reads as part of its neighbor.
 *   Color:  only colors the live sunnyandranney.com shows. One color, one job:
 *           gold = buy, teal = events, charcoal for words. The one exception is the charity section,
 *           which wears Sunshine on a Ranney Day's own identity (Peter, 2026-11-11), taken from
 *           sunshineonaranneyday.com and its brand guide at /branding/: the site's hero (Warm Gray,
 *           a Libre Baskerville headline with a highlighted italic word, a rounded photo, a yellow
 *           pill) over its impact strip (Dark Deep with Sunshine Yellow numbers).
 *   Type:   DM Sans (the site's font). Outlook falls back to Arial, Gmail to Helvetica.
 *   Space:  8 / 16 / 24 / 32 / 40 px; 40 becomes 32 on phones. Radius: 8 buttons, 12 cards. Photos square.
 *   Grid:   words and cards sit on one 536px column (32px sides; 20px on phones). Photos run the full
 *           600px. The photo wall's 4px gutters live inside its cells, split so the outer tiles touch
 *           both edges, because Gmail strips the negative margins that would otherwise do it.
 *   First screen: on a phone, the sale button lands within the first 600px (verify.mjs fails it otherwise).
 *   Contrast (WCAG AA): charcoal on white 14.0, on gold 9.9; white on teal 4.9; SOARD Dark on Warm
 *                       Gray 10.6, Muted on it 6.2; Sunshine Yellow on Dark Deep 12 -> all any size.
 * Every store link carries its own utm_content, so Kit's click report shows which slot was tapped.
 */

import { money } from './product.mjs';

// ── Tokens ──────────────────────────────────────────────────────────────────
export const GOLD = '#FFD400', TEAL = '#2B7A96';
export const CHARCOAL = '#2C2C2C', STONE = '#6B6B68', WHITE = '#FFFFFF';
const SANS = "'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const S1 = 8, S2 = 16, S3 = 24, S4 = 32, S5 = 40; // spacing scale
const R_BTN = 8, R_CARD = 12;
const LABEL_LH = 16; // line height of the small uppercase labels
const GUTTER = 4; // between photo wall tiles

export const SITE = 'https://sunnyandranney.com';
const MAP = 'https://maps.app.goo.gl/QXwgPyiX93HkwjwDA';
const CF = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const LOGO = `${CF}/logo-tagline-light-bg/w=360,h=144,fit=scale-down,format=png`; // 1000x400 original, 2.5:1
const PIG = `${CF}/logo-tagline-light-bg/trim=2;300;192;230,w=192,format=png`; // the flying pig, 192x84
const GREG = `${CF}/team/greg-ranney/w=88,h=88,fit=cover,gravity=auto,quality=70,format=jpeg`;

// ── The charity's identity, for its section only ────────────────────────────
// Values as sunshineonaranneyday.com renders them (its CSS variables), which its brand guide
// (/branding/) also lists: Sunshine Yellow for buttons and accents, SOARD Dark for words, Warm Gray
// for section backgrounds, Dark Deep for its impact strip, and its muted text.
export const SOARD_YELLOW = '#FFDA24', SOARD_DARK = '#373A36', SOARD_DEEP = '#1E1F25';
export const SOARD_WARM = '#F5F4F0', SOARD_MUTED = '#5A5B61';
const SERIF = "'Libre Baskerville', Georgia, 'Times New Roman', serif";
// Numbers fall back to Times New Roman, not Georgia: Georgia's figures are old-style, so in Gmail
// (no web fonts) "$0" read as "$o" and "295" dropped below the line.
const NUMERALS = "'Libre Baskerville', 'Times New Roman', Times, serif";
const OUTFIT = "'Outfit', 'Helvetica Neue', Helvetica, Arial, sans-serif";
// The guide's alternate logo (no tagline: "for smaller uses"), for light backgrounds, laid on the
// band's Warm Gray with 20px of its own margin (the 600x600 file's logo at 102-498 by 98-458, cut at
// 82-518 by 78-478: 436x400, shown at 132). The file is that crop of brand-logo-light-bg-display on
// #F5F4F0, uploaded as its own image. Its lettering is dark on a transparent background, and Gmail
// and Outlook darken backgrounds in dark mode but never images, so a transparent logo lost "on a
// Ranney Day" there; on its own tile it stays readable, and in light mode the tile is invisible.
// It's served as the "public" variant because Cloudflare turns resized opaque PNGs into JPEGs,
// which smudge the warm gray around the lettering.
const SOARD_LOGO = `${CF}/email/soard-logo-warm-tile/public`;
const LOGO_INSET = 6; // the tile's margin at 132px wide (20 of 436), taken out of the padding around it
const SOARD_HOME = 'https://sunshineonaranneyday.com/';
// The site's highlighter behind its key italic word: Sunshine Yellow at 30% over the lower half.
const HIGHLIGHT = 'linear-gradient(rgba(255,218,36,0) 52%, rgba(255,218,36,0.3) 52%)';

/** The phone width the first-screen rule is measured at, and how far down the sale button may sit. */
export const FIRST_SCREEN = 600;

// ── Text helpers ────────────────────────────────────────────────────────────
/** HTML-escapes text for an attribute or element: & < > " and ' */
export function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const UTF8 = new TextEncoder();
/** Percent-encodes like a URL query value: letters, digits and _.-~ stay, everything else is %XX (UTF-8). */
function encode(s, keep) {
  let out = '';
  for (const ch of String(s)) {
    if (/[A-Za-z0-9_.\-~]/.test(ch) || keep.includes(ch)) out += ch;
    else for (const byte of UTF8.encode(ch)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
/** Brief text as plain text, for calendar notes: no tags, entities decoded. */
const plain = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
/** A form-encoded query string: spaces become +. */
function formEncode(params) {
  return Object.entries(params).map(([k, v]) => `${encode(k, ' ').replace(/ /g, '+')}=${encode(v, ' ').replace(/ /g, '+')}`).join('&');
}

/**
 * Joins the last two words, so a wide line (headlines, the "when" line) never ends with one word
 * alone. Not for narrow columns, where the joined pair would force an earlier, worse break.
 */
export function noWidow(t) {
  let inside = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === '>') inside++;
    else if (t[i] === '<') inside--;
    else if (t[i] === ' ' && !inside) return t.slice(0, i) + '&nbsp;' + t.slice(i + 1);
  }
  return t;
}

/** A CSS pixel length, keeping fractions (the wall's split gutters) and dropping trailing zeros. */
function px(x) {
  return x ? x.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + 'px' : '0';
}

/** A percentage width as the table cells write it: 50.0, 33.33, 25.0 */
function pct(x) {
  const r = Math.round(x * 100) / 100;
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
}

/** Whole dollars with thousands separators: 1,000 */
const dollars = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── Dates (all calendar dates, no time zone) ────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** A 'YYYY-MM-DD' calendar date as a UTC-midnight Date. */
export function day(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Not a date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Not a date: ${iso}`);
  return d;
}
export const monthShort = (d) => MONTHS[d.getUTCMonth()];
export const weekday = (d) => DAYS[d.getUTCDay()];
const weekdayShort = (d) => DAYS[d.getUTCDay()].slice(0, 3);
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 86400000);

// ── The tiers' sizes ────────────────────────────────────────────────────────
/**
 * The tiers sit in one row, as many columns as tiers, with a charcoal rule between them. Every
 * column but the last keeps 8px clear before the next rule. A two-digit percent in bold DM Sans is
 * 2.08 times its size wide, so the number size by count is the largest that fits the narrowest
 * column at each width: (desktop 536px, phones 335px+, phones under 375px down to 280px).
 * Four tiers, or any tier from $10,000 up, write every amount in the row short ($2.5k+, $10k+),
 * since "$2,500+" can't break and is wider than a quarter of a small phone, and "$10,000+" is
 * wider than a third of one. Spend comes in multiples of $50, so the short form is always exact.
 * Under 375px no three- or four-tier caption fits on one line, so every caption in the row
 * stacks ("off" over the amount) and the columns stay even.
 */
export const TIER_SIZE = { 2: [80, 56, 56], 3: [64, 40, 32], 4: [52, 28, 22] };
export const amount = (spend, short) => (short && spend >= 1000 ? `$${String(spend / 1000)}k+` : `$${dollars(spend)}+`);

// ── What the subject and preheader promise ───────────────────────────────────
/**
 * The offer comes from the admin, where Staci sets it, but the subject and preheader are written
 * in the brief. So they can name it without typing its numbers: "{offer}" becomes the offer in a
 * line ("Spend $250, save 10%. Spend $1,000, save 20%." or "20% off everything.") and "{upto}"
 * its biggest percent ("20%"). Anything either line says about the discount is then checked
 * against the offer: every percent off must be one the sale gives, "up to" must be its biggest,
 * and in a tiered sale every dollar amount must be a tier, with that tier's own percent beside
 * it. "100% of our profits" is a share, not a discount.
 */
export function offerLine(sale) {
  if (sale?.kind === 'tiers') {
    const shown = sale.tiers.length > 2 ? [sale.tiers[0], sale.tiers[sale.tiers.length - 1]] : sale.tiers;
    return shown.map(([spend, off]) => `Spend $${dollars(spend)}, save ${off}%.`).join(' ');
  }
  if (sale?.kind === 'percent') return `${sale.percent}% off ${plain(sale.what)}`;
  throw new Error('The brief asks for {offer}, but this week has no discount.');
}

function mostOff(sale) {
  if (sale?.kind === 'tiers') return `${Math.max(...sale.tiers.map(([, off]) => off))}%`;
  if (sale?.kind === 'percent') return `${sale.percent}%`;
  throw new Error('The brief asks for {upto}, but this week has no discount.');
}

/** The subject and preheader as they go out, with {offer} and {upto} written from the offer. Throws if either promises what the offer doesn't give. */
export function lines(brief) {
  const fill = (t) => String(t || '').replace('{offer}', () => offerLine(brief.sale)).replace('{upto}', () => mostOff(brief.sale));
  const subject = fill(brief.subject);
  const preheader = fill(brief.preheader);
  const claims = [...offerClaims(subject, brief.sale, 'subject'), ...offerClaims(preheader, brief.sale, 'preheader')];
  if (claims.length) throw new Error(`The subject or preheader doesn't match the offer: ${claims.join(' ')}`);
  return { subject, preheader };
}

const spendOf = (digits, k) => Number(digits.replace(/,/g, '')) * (k ? 1000 : 1);
const MONEY = String.raw`\$(\d[\d,]*(?:\.\d+)?)(k)?`;

/** @returns {string[]} what the line says that the offer doesn't give, in words */
export function offerClaims(line, sale, where) {
  const text = plain(String(line || ''));
  const offs = sale?.kind === 'tiers' ? sale.tiers.map(([, off]) => off) : sale?.kind === 'percent' ? [sale.percent] : [];
  const gives = offs.length ? `the sale gives ${offs.map((o) => `${o}%`).join(', ')}` : 'this week has no discount';
  const problems = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%(?!\s+of\b)/gi)) {
    if (!offs.includes(Number(m[1]))) problems.push(`The ${where} says ${m[1]}%, but ${gives}.`);
  }
  for (const m of text.matchAll(/up to\s+(\d+)\s?%/gi)) {
    const most = Math.max(...offs);
    if (offs.length && Number(m[1]) !== most) problems.push(`The ${where} says up to ${m[1]}%, but the most the sale gives is ${most}%.`);
  }
  if (sale?.kind === 'tiers') {
    const tier = new Map(sale.tiers.map(([spend, off]) => [spend, off]));
    const list = sale.tiers.map(([spend]) => `$${dollars(spend)}`).join(', ');
    for (const m of text.matchAll(new RegExp(MONEY, 'gi'))) {
      if (!tier.has(spendOf(m[1], m[2]))) problems.push(`The ${where} says $${m[1].replace(/,$/, '')}${m[2] || ''}, but the tiers are ${list}.`);
    }
    // "Spend $250, save 10%" and "10% on $250"
    const pairs = [
      ...[...text.matchAll(new RegExp(String.raw`spend\s+${MONEY}[^$%]{0,12}?save\s+(\d+)\s?%`, 'gi'))].map((m) => [spendOf(m[1], m[2]), Number(m[3])]),
      ...[...text.matchAll(new RegExp(String.raw`(\d+)\s?%\s+(?:off\s+)?(?:on|over)\s+${MONEY}`, 'gi'))].map((m) => [spendOf(m[2], m[3]), Number(m[1])]),
    ];
    for (const [spend, off] of pairs) {
      if (tier.has(spend) && tier.get(spend) !== off) problems.push(`The ${where} pairs $${dollars(spend)} with ${off}%, but that tier gives ${tier.get(spend)}%.`);
    }
  }
  return problems;
}

// Products sit at most two to a row: three across leaves about 95px a tile on a small phone, too narrow
// for a name and price, and too small to tap. An odd count leads with one big product.
const WALL_ROWS = { 4: [2, 2], 5: [1, 2, 2], 6: [2, 2, 2], 7: [1, 2, 2, 2], 8: [2, 2, 2, 2], 9: [1, 2, 2, 2, 2] };
/** What each photo shows at 600px with the gutters taken out (3:2 for the lead, square for pairs). Outlook sizes images by these. */
const SHAPE = { 1: [600, 400], 2: [298, 298] };

/** Every section, top to bottom. A preview can ask for just the first few. */
export const SECTIONS = ['masthead', 'hero', 'offer', 'wall', 'story', 'events', 'mission', 'visit', 'footer'];

/** Builds one issue. Holds the brief so every link can be tagged for its slot. */
export class Email {
  constructor(brief) {
    this.b = brief;
    this.campaign = 'sunny-side-' + brief.send_date;
  }

  // ── links and images ──
  /** Tag store and charity links with their slot; leave maps, social and calendars alone. */
  url(href, slot) {
    if (!(href.startsWith(SITE) || href.startsWith('https://sunshineonaranneyday.com'))) return href;
    const tag = formEncode({ utm_source: 'kit', utm_medium: 'email', utm_campaign: this.campaign, utm_content: slot });
    return `${href}${href.includes('?') ? '&' : '?'}${tag}`;
  }

  static photo(src, w, h) {
    if (src.startsWith('cf:')) return `${CF}/${src.slice(3)}/w=${w},h=${h},fit=cover,gravity=auto,quality=64,format=jpeg`;
    return `${src}${src.includes('?') ? '&' : '?'}width=${w}&height=${h}&crop=center&quality=64`;
  }

  img(src, w, h, alt, href, slot, radius = 0, cls = '') {
    const c = cls ? ` class="${cls}"` : '';
    const tag =
      `<img${c} src="${escape(src)}" width="${w}" height="${h}" alt="${escape(alt)}" style="display:block;width:100%;` +
      `max-width:${w}px;height:auto;border:0;border-radius:${radius}px;">`;
    if (!href) return tag;
    return `<a href="${escape(this.url(href, slot))}" target="_blank" style="display:block;color:${CHARCOAL};">${tag}</a>`;
  }

  /** An edge-to-edge photo band. */
  fullPhoto(p, w, h, href, slot) {
    return this.band(this.img(Email.photo(p.src, w * 2, h * 2), w, h, p.alt, href, slot), { top: 0, side: 0, bottom: 0 });
  }

  link(text, href, slot, color = CHARCOAL, size = 15) {
    return (
      `<a href="${escape(this.url(href, slot))}" target="_blank" style="display:inline-block;padding:12px 0;` +
      `font-family:${SANS};font-size:${size}px;line-height:20px;font-weight:700;color:${color};` +
      `text-decoration:underline;text-underline-offset:3px;">${text}</a>`
    );
  }

  /**
   * Bulletproof: VML for Outlook, a padded link everywhere else. Full width on phones.
   * `pill` rounds the ends fully, the way the charity's site draws its buttons.
   */
  button(text, href, slot, bg, fg, align = 'left', { pill = false, font = SANS } = {}) {
    const u = escape(this.url(href, slot));
    const width = 56 + 9 * [...text.replace(/&#8594;/g, 'x').replace(/&#8217;/g, "'").replace(/&amp;/g, '&')].length;
    const radius = pill ? 999 : R_BTN;
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" class="btn" ` +
      `style="border-collapse:separate;"><tr><td bgcolor="${bg}" style="border-radius:${radius}px;background-color:${bg};">` +
      `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" ` +
      `href="${u}" style="height:52px;v-text-anchor:middle;width:${width}px;" arcsize="${pill ? '50%' : '15%'}" stroke="f" fillcolor="${bg}">` +
      `<w:anchorlock/><center style="color:${fg};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${text}</center>` +
      `</v:roundrect><![endif]--><!--[if !mso]><!-->` +
      `<a href="${u}" target="_blank" style="display:inline-block;padding:16px 28px;font-family:${font};font-size:16px;` +
      `line-height:20px;font-weight:700;color:${fg};text-decoration:none;border-radius:${radius}px;border:2px solid ${bg};">${text}</a>` +
      `<!--<![endif]--></td></tr></table>`
    );
  }

  // ── layout primitives ──
  static T(inner, attrs = 'width="100%"') {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ${attrs}>${inner}</table>`;
  }

  /**
   * One full-width row of the email. Phone padding follows from desktop padding:
   * 40 top/bottom -> 32 (pt, pb), 32 sides -> 20 (px); anything else stays as is.
   */
  band(inner, { bg = WHITE, top = S5, side = S4, bottom = S5, cls = '' } = {}) {
    const c = [side === S4 ? 'px' : '', top === S5 ? 'pt' : '', bottom === S5 ? 'pb' : '', cls].filter(Boolean).join(' ');
    const attr = c ? ` class="${c}"` : '';
    return (
      `<tr><td${attr} bgcolor="${bg}" style="background-color:${bg};color:${CHARCOAL};` +
      `padding:${top}px ${side}px ${bottom}px;">${inner}</td></tr>`
    );
  }

  static gap(h, cls = '') {
    const c = cls ? ` class="${cls}"` : '';
    return `<div${c} style="height:${h}px;line-height:${h}px;font-size:${h}px;">&nbsp;</div>`;
  }

  /** White space between a photo and a block it doesn't belong to (40px, 32 on phones). */
  breather() {
    return this.band(Email.gap(S5, 'g40'), { top: 0, side: 0, bottom: 0 });
  }

  static text(t, { size = 17, lh = 26, weight = 400, color = CHARCOAL, mb = 0, align = 'left', tag = 'p', cls = '', track = '', font = SANS } = {}) {
    const c = cls ? ` class="${cls}"` : '';
    const ls = track ? `letter-spacing:${track};` : '';
    return (
      `<${tag}${c} style="margin:0 0 ${mb}px;font-family:${font};font-size:${size}px;line-height:${lh}px;` +
      `font-weight:${weight};${ls}color:${color};text-align:${align};mso-line-height-rule:exactly;">${t}</${tag}>`
    );
  }

  static label(t, { color = CHARCOAL, mb = S1, align = 'left', font = SANS, track = '0.14em' } = {}) {
    return (
      `<p style="margin:0 0 ${mb}px;font-family:${font};font-size:12px;line-height:${LABEL_LH}px;font-weight:700;` +
      `letter-spacing:${track};text-transform:uppercase;color:${color};text-align:${align};">${t}</p>`
    );
  }

  static h2(t, { color = CHARCOAL, mb = 12 } = {}) {
    return Email.text(noWidow(t), { size: 30, lh: 34, weight: 700, color, mb, tag: 'h2', cls: 'h2', track: '-0.015em' });
  }

  // ── sections, top to bottom ──
  /** Slim, like a magazine masthead: the logo left, the newsletter's name and issue date right. */
  masthead() {
    const d = day(this.b.send_date);
    const logo =
      `<a href="${escape(this.url(SITE + '/', 'masthead'))}" target="_blank" class="logo" ` +
      `style="display:block;width:150px;color:${CHARCOAL};">` +
      `<img class="logo" src="${LOGO}" width="150" height="60" alt="Sunny &amp; Ranney" ` +
      `style="display:block;width:150px;height:auto;border:0;"></a>`;
    const name =
      Email.label('The Sunny Side', { mb: 2, align: 'right' }) +
      Email.text(`${monthShort(d)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`, { size: 13, lh: 18, align: 'right' });
    return this.band(
      Email.T(`<tr><td valign="middle">${logo}</td>` + `<td align="right" valign="middle" style="padding-left:${S2}px;">${name}</td></tr>`),
      { top: S2, bottom: S2 },
    );
  }

  hero() {
    return this.fullPhoto(this.b.hero, 600, 300, SITE + this.b.sale.url, 'hero-photo');
  }

  tiers(tiers) {
    const n = tiers.length;
    if (!(n >= 2 && n <= 4)) throw new Error(`sale.tiers: the offer shows 2 to 4 tiers, not ${n}`);
    const size = TIER_SIZE[n][0];
    const short = n === 4 || tiers.some(([spend]) => typeof spend === 'number' && spend >= 10000);
    let tds = '';
    tiers.forEach(([spend, percent], k) => {
      const rule = k ? `border-left:2px solid ${CHARCOAL};padding-left:14px;` : '';
      const clear = k < n - 1 ? `padding-right:${S1}px;` : '';
      const cap = [n >= 3 ? 'cap' : '', n === 4 ? 'cap4' : ''].filter(Boolean).join(' ');
      tds +=
        `<td width="${pct(100 / n)}%" valign="top" style="${rule}${clear}">` +
        Email.text(`${percent}%`, { size, lh: size, weight: 700, cls: `tier${n}`, track: '-0.04em', mb: 4 }) +
        Email.text(`off ${amount(spend, short)}`, { size: 15, lh: 20, weight: 700, cls: cap }) +
        '</td>';
    });
    return Email.T(`<tr>${tds}</tr>`, 'width="100%" style="table-layout:fixed;"');
  }

  offer() {
    const s = this.b.sale;
    let out = Email.label(s.name);
    if (s.kind === 'percent') {
      out +=
        `<h1 class="mega" style="margin:0;font-family:${SANS};font-size:92px;line-height:88px;font-weight:700;` +
        `letter-spacing:-0.045em;color:${CHARCOAL};mso-line-height-rule:exactly;">${s.percent}%&nbsp;off</h1>` +
        Email.text(s.what, { size: 40, lh: 44, weight: 700, mb: S3, cls: 'mega2', track: '-0.025em' });
    } else {
      out += Email.text(noWidow(s.headline), { size: 32, lh: 36, weight: 700, mb: s.kind === 'tiers' ? S3 : S2, tag: 'h1', cls: 'h2', track: '-0.015em' });
      if (s.kind === 'tiers') out += this.tiers(s.tiers) + Email.gap(S3);
    }
    out += this.button(`${s.cta} &#8594;`, SITE + s.url, 'offer-button', CHARCOAL, WHITE);
    // fine print after the button, so it never pushes the button down
    if (s.details) out += Email.gap(S2) + Email.text(s.details, { size: 15, lh: 22 });
    return this.band(out, { bg: GOLD, top: S4 });
  }

  /**
   * One product: its photo, its name and its price, all one link to its page on sunnyandranney.com.
   * The photo runs edge to edge like the rest of the wall; the words sit inset by the column's margin
   * from the tile's own edge, so the first tile's words line up with the rest of the email.
   */
  tile(ph, cw, ch, slot) {
    if (!ph.name || !(ph.price > 0)) throw new Error(`wall: every product needs its name and price (${slot}).`);
    return (
      `<a href="${escape(this.url(ph.url, slot))}" target="_blank" style="display:block;color:${CHARCOAL};text-decoration:none;">` +
      `<img src="${escape(Email.photo(ph.src, cw * 2, ch * 2))}" width="${cw}" height="${ch}" alt="" ` +
      `style="display:block;width:100%;max-width:${cw}px;height:auto;border:0;">` +
      `<span class="tile-cap" style="display:block;padding:10px 12px ${S3}px ${S4}px;">` +
      `<span class="tile-name" style="display:block;font-family:${SANS};font-size:15px;line-height:20px;font-weight:700;color:${CHARCOAL};">${ph.name}</span>` +
      `<span class="tile-price" style="display:block;font-family:${SANS};font-size:15px;line-height:20px;font-weight:400;color:${CHARCOAL};">${money(ph.price)}</span>` +
      `</span></a>`
    );
  }

  wall() {
    const w = this.b.wall;
    const shop = SITE + (w.more || '/shop/'); // "Shop all" goes where the brief says the products come from
    const head =
      Email.T(
        `<tr><td valign="middle">${Email.label(w.label, { mb: 0 })}</td>` +
          `<td align="right" valign="middle" style="white-space:nowrap;padding-left:${S2}px;">` +
          `${this.link('Shop all &#8594;', shop, 'wall-shop-all')}</td></tr>`,
      ) + Email.h2(w.headline, { mb: 0 });
    let rows = '';
    let i = 0;
    WALL_ROWS[w.photos.length].forEach((n) => {
      const [cw, ch] = SHAPE[n];
      let tds = '';
      w.photos.slice(i, i + n).forEach((ph, k) => {
        // Split each gutter between its two tiles so every tile is the same width and the
        // outer tiles touch the edges: tile k pads GUTTER*k/n on the left, the rest on the right.
        const left = (GUTTER * k) / n, right = (GUTTER * (n - 1 - k)) / n;
        tds +=
          `<td width="${pct(100 / n)}%" valign="top" style="padding:0 ${px(right)} 0 ${px(left)};">` +
          this.tile(ph, cw, ch, `wall-${i + k + 1}`) +
          '</td>';
      });
      rows += '<tr><td>' + Email.T(`<tr>${tds}</tr>`, 'width="100%" style="table-layout:fixed;"') + '</td></tr>';
      i += n;
    });
    return this.band(head, { top: S5, bottom: S2 }) + this.band(Email.T(rows), { top: 0, side: 0, bottom: 0 });
  }

  story() {
    const s = this.b.story;
    if (!s) return '';
    const href = SITE + s.cta[1];
    return (
      this.band(Email.label(s.label) + Email.h2(s.headline) + Email.text(s.body, { mb: S1 }) + this.link(`${s.cta[0]} &#8594;`, href, 'story-link'), {
        top: S5,
        bottom: S2,
      }) + this.fullPhoto(s.photo, 600, 240, href, 'story-photo')
    );
  }

  /** The dates still ahead on send day, in order. Month, day and weekday all come from "date". */
  upcoming(e) {
    const sent = day(this.b.send_date);
    const items = e.items
      .map((it) => ({ ...it, d: day(it.date) }))
      .sort((a, b) => a.d - b.d)
      .filter((it) => it.d >= sent);
    if (!items.length) return [null, [], ''];
    const first = items[0];
    const when = daysBetween(sent, first.d) <= 6 ? `This ${weekday(first.d)}` : 'Up next';
    return [first, items.slice(1), `${when} &middot; ${monthShort(first.d)} ${first.d.getUTCDate()}`];
  }

  /** The line over the list, true to the dates: weekly only when they really are a week apart. */
  /**
   * The line under the event title, written from the dates still ahead so it can't go stale:
   * "Saturdays, 11am–2pm, Nov 21 to Dec 19". With one date left the card already says it all, so
   * there's no line. Events on different weekdays lead with the brief's "when", which says what's
   * on but never when: a date typed into it would go stale the week it passed.
   */
  static span(e, dates) {
    if (e.when && new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+\\d`).test(e.when)) {
      throw new Error(`events: "when" can't name dates ("${e.when}"). The email writes them from the dates still ahead.`);
    }
    const mixed = new Set(dates.map((d) => d.getUTCDay())).size > 1;
    if (mixed && !e.when) throw new Error(`events: "${e.title}" falls on different weekdays, so it needs a "when" saying what's on.`);
    if (!mixed && e.when) throw new Error(`events: leave out "when" for "${e.title}". It's all on ${weekday(dates[0])}s, so the email writes the line.`);
    if (dates.length === 1) return '';
    const md = (d) => `${monthShort(d)} ${d.getUTCDate()}`;
    const range = `${md(dates[0])} to ${md(dates[dates.length - 1])}`;
    if (mixed) return `${e.when}, ${range}`;
    // "Kids' Christmas Saturdays" already says the day, so the line doesn't say it again
    const days = `${weekday(dates[0])}s`;
    return new RegExp(`\\b${days}\\b`, 'i').test(e.title) ? `${e.time}, ${range}` : `${days}, ${e.time}, ${range}`;
  }

  static leadIn(rest) {
    if (rest.length === 1) return 'One more date:';
    if (new Set(rest.map((it) => it.d.getUTCDay())).size > 1) return 'More dates:';
    const weekly = rest.slice(1).every((it, k) => daysBetween(rest[k].d, it.d) === 7);
    return weekly ? `Then every ${weekday(rest[0].d)}:` : `More ${weekday(rest[0].d)}s:`;
  }

  /**
   * Calendar links for a weekly series, written from the dates still ahead so no one adds one that
   * has passed: Google gets them as a weekly event with each date's activity in its notes, Apple and
   * Outlook the series' calendar file. The brief gives the title, the hours ("start", "end" as
   * HH:MM), a line about the series ("intro") and the file ("ics").
   */
  calendar(e, items) {
    const c = e.calendar;
    if (!items.slice(1).every((it, k) => daysBetween(items[k].d, it.d) === 7)) {
      throw new Error(`events: "${e.title}" has calendar links, but its dates aren't a week apart.`);
    }
    const hms = (t) => {
      if (!/^\d{2}:\d{2}$/.test(t || '')) throw new Error(`events: the calendar's "start" and "end" are HH:MM, like "11:00".`);
      return t.replace(':', '') + '00';
    };
    const day = items[0].d.toISOString().slice(0, 10).replace(/-/g, '');
    const q = {
      action: 'TEMPLATE',
      text: c.title,
      dates: `${day}T${hms(c.start)}/${day}T${hms(c.end)}`,
      ctz: 'America/New_York',
      location: 'Sunny & Ranney, 109A Oak Street, Roswell, GA',
      details: [c.intro, ...items.map((it) => `${monthShort(it.d)} ${it.d.getUTCDate()}: ${plain(it.what)}${it.note ? `. ${plain(it.note)}` : ''}`)].join('\n'),
    };
    if (items.length > 1) q.recur = `RRULE:FREQ=WEEKLY;COUNT=${items.length}`;
    const google = 'https://calendar.google.com/calendar/render?' + Object.entries(q).map(([k, v]) => `${k}=${encode(v, '/')}`).join('&');
    const dot = `<span style="font-family:${SANS};color:${WHITE};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`;
    return (
      Email.text(items.length > 1 ? 'Add every date to your calendar:' : 'Add it to your calendar:', { size: 15, lh: 20, color: WHITE }) +
      this.link('Google', google, 'cal-google', WHITE) +
      dot +
      this.link('Apple', c.ics, 'cal-apple', WHITE) +
      dot +
      this.link('Outlook', c.ics, 'cal-outlook', WHITE)
    );
  }

  static greg(it) {
    if (!it.greg) return '';
    return (
      `<td width="52" align="right" valign="middle"><img src="${GREG}" width="44" height="44" ` +
      `alt="Greg, the store&#8217;s French bulldog" style="display:block;width:44px;height:44px;` +
      `border-radius:22px;border:0;"></td>`
    );
  }

  events() {
    let out = '';
    for (const e of this.b.events || []) {
      const [first, rest, when] = this.upcoming(e);
      if (!first) continue;
      const spot = Email.T(
        `<tr><td valign="top" bgcolor="${WHITE}" style="background-color:${WHITE};border-radius:${R_CARD}px;padding:${S2}px;">` +
          Email.T(
            `<tr><td valign="middle">` +
              Email.label(when, { mb: 6 }) +
              Email.text(noWidow(first.what), { size: 24, lh: 29, weight: 700, cls: 'spot' }) +
              (first.note ? Email.text(first.note, { size: 15, lh: 21 }) : '') +
              Email.text(`${first.time || e.time} at the showroom`, { size: 15, lh: 21, weight: 700 }) +
              `</td>${Email.greg(first)}</tr>`,
          ) +
          '</td></tr>',
        'width="100%" style="border-collapse:separate;"',
      );
      let agenda = '';
      if (rest.length) {
        // The rest as a list on the teal: the date, then what's on, white rules between rows.
        // The weekday shows only when the dates fall on different days.
        const days = new Set(rest.map((it) => it.d.getUTCDay())).size > 1;
        let rows = '';
        rest.forEach((it, k) => {
          const rule = k ? `border-top:1px solid ${WHITE};` : '';
          const dateCell =
            (days ? Email.label(weekdayShort(it.d), { color: WHITE, mb: 2 }) : '') +
            Email.text(monthShort(it.d).toUpperCase() + `&nbsp;${it.d.getUTCDate()}`, { size: 15, lh: 22, weight: 700, color: WHITE, track: '0.06em' });
          const ownTime = it.time !== e.time ? it.time : undefined; // the series time is in "when"
          const whatCell =
            Email.text(it.what, { size: 16, lh: 22, weight: 700, color: WHITE }) + // narrow column: no widow joins
            (ownTime ? Email.text(ownTime, { size: 14, lh: 20, weight: 700, color: WHITE }) : '') +
            (it.note ? Email.text(it.note, { size: 14, lh: 20, color: WHITE }) : '');
          const level = days ? ` style="padding-top:${LABEL_LH + 2}px;"` : ''; // level with the date
          rows +=
            `<tr><td style="${rule}padding:12px 0;">` +
            Email.T(
              `<tr><td width="76" valign="top" style="padding-right:${S1}px;">${dateCell}</td>` + `<td valign="top"${level}>${whatCell}</td>${Email.greg(it)}</tr>`,
            ) +
            '</td></tr>';
        });
        agenda = Email.gap(S3) + Email.text(Email.leadIn(rest), { size: 16, lh: 22, weight: 700, color: WHITE, mb: 4 }) + Email.T(rows);
      }
      const line = Email.span(e, [first, ...rest].map((it) => it.d));
      const head =
        Email.label(e.label ?? 'Coming up', { color: WHITE }) +
        Email.h2(e.title, { color: WHITE, mb: line ? 6 : S2 }) +
        (line ? Email.text(noWidow(line), { size: 16, lh: 24, color: WHITE, mb: S2 }) : '');
      const foot = Email.gap(S2) + (e.calendar ? this.calendar(e, [first, ...rest]) : '');
      out += this.breather() + this.band(head + spot + agenda + foot, { bg: TEAL, bottom: S4 });
    }
    return out;
  }

  /**
   * The charity's section, built the way sunshineonaranneyday.com builds its home page: a light hero
   * (its logo, why it's here, a Libre Baskerville headline with the key words in highlighted italic,
   * the latest reveal in a rounded photo with its caption, the story in two sentences, and the yellow
   * pill), then its impact strip, Sunshine Yellow numbers on Dark Deep, read live from its site each
   * week by the build. The `soard` class lets verify.mjs hold the section to the charity's palette and
   * the rest of the email to the store's.
   */
  mission() {
    const m = this.b.mission;
    const logo =
      `<a href="${escape(this.url(SOARD_HOME, 'charity-logo'))}" target="_blank" style="display:block;width:132px;color:${SOARD_DARK};">` +
      `<img class="soard-logo" src="${SOARD_LOGO}" width="132" height="121" alt="Sunshine on a Ranney Day" ` +
      `style="display:block;width:132px;height:auto;border:0;border-radius:8px;"></a>`;
    // The logo's own row, its padding short by the tile's margin, so the lettering sits exactly where
    // a transparent logo's would: on the column, 40px down (32 and 20 on phones, via ptl and pxl).
    const logoRow = this.band(logo, { bg: SOARD_WARM, top: S5 - LOGO_INSET, side: S4 - LOGO_INSET, bottom: 0, cls: 'soard ptl pxl' });
    const headline =
      `<h2 class="soard-h soard-serif" style="margin:0;font-family:${SERIF};font-size:34px;line-height:40px;font-weight:700;` +
      `letter-spacing:-0.02em;color:${SOARD_DARK};mso-line-height-rule:exactly;">Every purchase builds a&nbsp;` +
      `<em style="font-family:${SERIF};font-style:italic;font-weight:700;color:${SOARD_DARK};background-image:${HIGHLIGHT};">` +
      `dream&nbsp;room</em>.</h2>`;
    const hero = this.band(
      Email.label('Where 100% of our profits go', { color: SOARD_MUTED, font: OUTFIT, track: '0.1em' }) +
        headline +
        Email.gap(S3) +
        this.img(Email.photo(m.photo.src, 1072, 604), 536, 302, m.photo.alt, m.url, 'mission-photo', 24) +
        (m.caption ? Email.gap(S1) + Email.text(m.caption, { size: 13, lh: 18, weight: 600, color: SOARD_MUTED, font: OUTFIT, mb: S2 }) : Email.gap(S3)) +
        Email.text(m.story, { size: 17, lh: 27, color: SOARD_DARK, mb: S3, font: OUTFIT }) +
        this.button(`${m.cta} &#8594;`, m.url, 'mission-button', SOARD_YELLOW, SOARD_DARK, 'left', { pill: true, font: OUTFIT }),
      { bg: SOARD_WARM, top: S3 - LOGO_INSET, cls: 'soard' }, // 24px under the lettering, as before
    );
    return this.breather() + logoRow + hero + (m.impact ? this.impact(m.impact) : '');
  }

  /** The charity's impact strip: its own numbers, as its site shows them, Sunshine Yellow on Dark Deep. */
  impact(n) {
    const stats = [
      [n.rooms, 'Room makeovers'],
      [n.children, 'Children served'],
      ['$0', 'Cost to families'],
    ];
    const tds = stats
      .map(
        ([num, what], k) =>
          `<td width="${pct(100 / 3)}%" valign="top" style="${k < 2 ? `padding-right:${S1}px;` : ''}">` +
          Email.text(num, { size: 40, lh: 44, weight: 700, color: SOARD_YELLOW, font: NUMERALS, cls: 'soard-stat soard-serif', track: '-0.02em', mb: 4 }) +
          Email.label(what, { color: WHITE, mb: 0, font: OUTFIT, track: '0.08em' }) +
          '</td>',
      )
      .join('');
    return this.band(Email.T(`<tr>${tds}</tr>`, 'width="100%" style="table-layout:fixed;"'), { bg: SOARD_DEEP, top: S4, bottom: S4, cls: 'soard' });
  }

  visit() {
    const left =
      Email.label('Visit the showroom') +
      Email.h2('109A Oak Street', { mb: 4 }) +
      Email.text('Roswell, GA', { size: 16, lh: 24, weight: 700, mb: S1 }) +
      Email.text('Tue&#8211;Sat, 10am&#8211;5pm<br>Closed Sun&nbsp;&amp;&nbsp;Mon', { size: 16, lh: 24 }) +
      Email.text(
        `<a href="tel:+16788885140" style="display:inline-block;padding:10px 0;color:${CHARCOAL};` +
          `text-decoration:underline;text-underline-offset:3px;">678.888.5140</a>`,
        { size: 16, lh: 24 },
      );
    return this.band(
      Email.T(
        `<tr><td class="stack" valign="middle">${left}</td>` +
          `<td class="stack stack-gap" width="210" align="right" valign="middle">` +
          `${this.button('Get directions &#8594;', MAP, 'directions', GOLD, CHARCOAL, 'right')}</td></tr>`,
      ),
    );
  }

  footer() {
    const links = [
      ['Instagram', 'https://instagram.com/sunnyandranney', 'ig'],
      ['Facebook', 'https://facebook.com/sunnyandranney', 'fb'],
      ['Shop online', SITE + '/shop/', 'footer-shop'],
    ]
      .map(
        ([t, h, slot]) =>
          `<a href="${escape(this.url(h, slot))}" target="_blank" style="display:inline-block;padding:12px 2px;` +
          `color:${CHARCOAL};text-decoration:underline;">${t}</a>`,
      )
      .join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;');
    return this.band(
      `<div style="height:1px;line-height:1px;font-size:1px;background-color:${STONE};margin:0 0 ${S3}px;">&nbsp;</div>` +
        `<img src="${PIG}" width="96" height="42" alt="" style="display:block;width:96px;height:auto;border:0;margin:0 auto ${S2}px;">` +
        Email.text('Designer finds. Better prices. A&nbsp;really&nbsp;good&nbsp;cause.', { size: 15, lh: 22, weight: 700, align: 'center', mb: 4 }) +
        Email.text('100% of our profits fund dream rooms for kids with special&nbsp;needs.', { size: 14, lh: 20, align: 'center', mb: 4 }) +
        Email.text(links, { size: 14, lh: 22, align: 'center', mb: 4 }) +
        // Kit fills {{ address }}; wrapping it in a link stops Gmail turning it into a blue autolink
        Email.text(
          `<a href="${escape(this.url('https://sunshineonaranneyday.com/', 'footer-address'))}" target="_blank" ` +
            `style="display:inline-block;padding:12px 0;color:${CHARCOAL};text-decoration:none;">{{ address }}</a><br>` +
            `<a href="{{ unsubscribe_url }}" style="display:inline-block;padding:12px 4px;color:${CHARCOAL};` +
            `text-decoration:underline;">Unsubscribe</a>`,
          { size: 13, lh: 20, align: 'center' },
        ),
      { top: 0, bottom: S4 },
    );
  }

  // ── page ──
  /** The whole email, or (for the admin's preview) just the sections asked for, as a complete document. */
  html(sections = SECTIONS) {
    const b = this.b;
    const { subject, preheader } = lines(b);
    const body = sections.map((name) => this[name]()).join('');
    const spacer = '&#847;&zwnj;&nbsp;'.repeat(60);
    const tiers = Object.entries(TIER_SIZE)
      .map(([n, [, phone]]) => `    .tier${n} { font-size:${phone}px !important; line-height:${phone}px !important; }`)
      .join('\n');
    const smallTiers = Object.entries(TIER_SIZE)
      .map(([n, [, , small]]) => `    .tier${n} { font-size:${small}px !important; line-height:${small}px !important; }`)
      .join('\n');
    return `<!DOCTYPE html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escape(subject)}</title>
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,700&family=Libre+Baskerville:ital,wght@0,700;1,400&family=Outfit:wght@400;700&display=swap" rel="stylesheet"><!--<![endif]-->
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<!--[if mso]><style>body, table, td, p, a, h1, h2, span { font-family: Arial, Helvetica, sans-serif !important; } .soard-serif, .soard-serif em { font-family: Georgia, serif !important; } .soard-stat { font-family: 'Times New Roman', serif !important; }</style><![endif]-->
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  img { -ms-interpolation-mode:bicubic; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media (max-width:620px) {
    .px { padding-left:20px !important; padding-right:20px !important; }
    .pt { padding-top:${S4}px !important; }
    .pb { padding-bottom:${S4}px !important; }
    .g40 { height:${S4}px !important; line-height:${S4}px !important; font-size:${S4}px !important; }
    .logo { width:120px !important; }
    .h2 { font-size:26px !important; line-height:30px !important; }
    .mega { font-size:76px !important; line-height:74px !important; }
    .mega2 { font-size:32px !important; line-height:36px !important; }
${tiers}
    .cap4 { font-size:13px !important; line-height:18px !important; }
    .spot { font-size:21px !important; line-height:26px !important; }
    .pxl { padding-left:${20 - LOGO_INSET}px !important; padding-right:${20 - LOGO_INSET}px !important; }
    .ptl { padding-top:${S4 - LOGO_INSET}px !important; }
    .soard-h { font-size:28px !important; line-height:34px !important; }
    .tile-cap { padding-left:20px !important; padding-right:8px !important; }
    .soard-stat { font-size:32px !important; line-height:36px !important; }
    .stack { display:block !important; width:100% !important; text-align:left !important; }
    .stack-gap { padding-top:${S3}px !important; }
    .btn { width:100% !important; float:none !important; }
    .btn a { display:block !important; text-align:center !important; }
  }
  @media (max-width:374px) {
${smallTiers}
    .cap { width:min-content !important; }   /* "off" over the amount in every column, not just the narrow ones */
    .soard-stat { font-size:28px !important; line-height:32px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${WHITE};color:${CHARCOAL};">
<div role="article" aria-roledescription="email" aria-label="${escape(subject)}" lang="en" dir="ltr">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escape(preheader)}${spacer}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${WHITE}" style="background-color:${WHITE};">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background-color:${WHITE};">
${body}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>
`;
  }
}

/** The email for one brief. */
export const render = (brief, sections) => new Email(brief).html(sections);
