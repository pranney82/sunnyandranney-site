import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { Email, amount, escape, lines, noWidow, offerClaims, offerLine, render } from './email.mjs';
import {
  blank,
  check,
  clean,
  draftSale,
  forKind,
  isSendDate,
  nextSend,
  previewBrief,
  sendLabel,
  summary,
  termsLine,
  toSale,
  typeset,
  upcomingSends,
} from './special.mjs';
import { clearSpecial, getSpecial, pastSpecials, putSpecial, specialsBetween } from './special-store.mjs';
import { impactFromPage } from './impact.mjs';

const SEND = '2026-11-17';
const TERMS = { where: 'both', ends: '2026-11-29' };
const tiers = (rows, extra = {}) => clean({ kind: 'tiers', headline: 'The holidays are here. So are the savings.', tiers: rows, ...TERMS, ...extra });
const percent = (extra = {}) => clean({ kind: 'percent', percent: 20, what: 'everything', ...TERMS, ...extra });

// ─── The email's building blocks ─────────────────────────────────────
test('escape covers the five characters HTML cares about', () => {
  assert.equal(escape(`Sunny & "Ranney" <'s>`), 'Sunny &amp; &quot;Ranney&quot; &lt;&#x27;s&gt;');
});

test('noWidow joins the last two words, outside tags only', () => {
  assert.equal(noWidow('Nov 14 to Dec 19'), 'Nov 14 to Dec&nbsp;19');
  assert.equal(noWidow('a <b class="x">bold</b>'), 'a&nbsp;<b class="x">bold</b>');
  assert.equal(noWidow('one'), 'one');
});

test('amounts are written in full, or short when asked', () => {
  assert.equal(amount(1000, false), '$1,000+');
  assert.equal(amount(2500, true), '$2.5k+');
  assert.equal(amount(1250, true), '$1.25k+');
  assert.equal(amount(500, true), '$500+');
  assert.equal(amount('?', true), '$?+');
});

test('a row with a $10,000+ tier writes every amount short, so the row stays even', () => {
  const html = new Email({ send_date: SEND }).tiers([[5000, 10], [10000, 15], [25000, 20]]);
  assert.match(html, /off \$5k\+/);
  assert.match(html, /off \$10k\+/);
  assert.doesNotMatch(html, /\$5,000\+/);
  assert.throws(() => new Email({ send_date: SEND }).tiers([[250, 10]]), /2 to 4 tiers/);
});

test('the list over the events says only what the dates support', () => {
  const d = (...isos) => isos.map((iso) => ({ d: new Date(`${iso}T00:00:00Z`) }));
  assert.equal(Email.leadIn(d('2026-11-21', '2026-11-28', '2026-12-05')), 'Then every Saturday:');
  assert.equal(Email.leadIn(d('2026-11-21', '2026-12-05')), 'More Saturdays:');
  assert.equal(Email.leadIn(d('2026-12-05', '2026-12-10')), 'More dates:');
  assert.equal(Email.leadIn(d('2026-12-19')), 'One more date:');
});

test('the line under the event title comes from the dates still ahead, so it never goes stale', () => {
  const d = (...isos) => isos.map((iso) => new Date(`${iso}T00:00:00Z`));
  const sat = { title: 'Kids’ Christmas Saturdays', time: '11am&#8211;2pm' };
  // The title already says "Saturdays", so the line doesn't say it again; a title that doesn't, gets it
  assert.equal(Email.span(sat, d('2026-11-21', '2026-11-28', '2026-12-19')), '11am&#8211;2pm, Nov 21 to Dec 19');
  assert.equal(Email.span({ ...sat, title: 'Holiday crafts' }, d('2026-11-21', '2026-11-28')), 'Saturdays, 11am&#8211;2pm, Nov 21 to Nov 28');
  assert.equal(Email.span(sat, d('2026-12-19')), ''); // the card already says it all
  const mixed = { title: 'December', when: 'Late shopping nights and Saturday crafts' };
  assert.equal(Email.span(mixed, d('2026-12-03', '2026-12-12')), 'Late shopping nights and Saturday crafts, Dec 3 to Dec 12');
  // A typed date would go stale the week it passed, so it stops the build
  assert.throws(() => Email.span({ ...mixed, when: 'Crafts, Nov 14 to Dec 19' }, d('2026-12-03', '2026-12-12')), /can't name dates/);
  assert.throws(() => Email.span({ ...mixed, when: 'Crafts through December 19' }, d('2026-12-03', '2026-12-12')), /can't name dates/);
  assert.doesNotThrow(() => Email.span({ ...mixed, when: 'Decorate a cookie, 11am&#8211;2pm' }, d('2026-12-03', '2026-12-12')));
  assert.throws(() => Email.span({ ...sat, when: 'Saturdays' }, d('2026-11-21', '2026-11-28')), /leave out "when"/);
  assert.throws(() => Email.span({ title: 'December' }, d('2026-12-03', '2026-12-12')), /needs a "when"/);
});

test('the calendar links start at the next date, with only the dates still ahead', () => {
  const e = {
    title: 'Kids’ Christmas Saturdays',
    time: '11am&#8211;2pm',
    calendar: { title: 'Kids at S&R', start: '11:00', end: '14:00', intro: 'Holiday crafts for kids, 11am-2pm:', ics: 'https://sunnyandranney.com/events/x.ics' },
    items: [
      { date: '2026-11-14', what: 'Build a snowman' },
      { date: '2026-11-21', what: 'Write a letter to Santa' },
      { date: '2026-11-28', what: 'Color a Sunny &amp; Ranney banner', note: 'Plus Greg, aka Santa&nbsp;Paws' },
    ],
  };
  const html = new Email({ send_date: '2026-11-17', events: [e] }).events();
  const google = decodeURIComponent(html.match(/href="(https:\/\/calendar\.google\.com[^"]+)"/)[1].replace(/&amp;/g, '&'));
  assert.match(google, /dates=20261121T110000\/20261121T140000/);
  assert.match(google, /recur=RRULE:FREQ=WEEKLY;COUNT=2/);
  assert.match(google, /Nov 21: Write a letter to Santa\nNov 28: Color a Sunny & Ranney banner\. Plus Greg, aka Santa Paws/);
  assert.doesNotMatch(google, /Nov 14|snowman/);
  assert.match(html, /Add every date to your calendar:/);
  // One date left: one event, no repeat
  const last = new Email({ send_date: '2026-11-24', events: [e] }).events();
  assert.doesNotMatch(last, /recur=/);
  assert.match(last, /Add it to your calendar:/);
  assert.throws(() => new Email({ send_date: '2026-11-17', events: [{ ...e, calendar: { ...e.calendar, start: '11am' } }] }).events(), /HH:MM/);
});

test('past event dates drop out, and the next one is "this" or "up next"', () => {
  const e = { items: [{ date: '2026-11-14', what: 'a' }, { date: '2026-11-21', what: 'b' }, { date: '2026-12-05', what: 'c' }] };
  const [first, rest, when] = new Email({ send_date: '2026-11-17' }).upcoming(e);
  assert.equal(first.what, 'b');
  assert.deepEqual(rest.map((it) => it.what), ['c']);
  assert.equal(when, 'This Saturday &middot; Nov 21');
  assert.equal(new Email({ send_date: '2026-11-10' }).upcoming({ items: [{ date: '2026-11-30', what: 'x' }] })[2], 'Up next &middot; Nov 30');
  assert.equal(new Email({ send_date: '2026-12-21' }).upcoming(e)[0], null);
});

// ─── What Staci types ────────────────────────────────────────────────
test('clean reads numbers the way people type them and drops anything unknown', () => {
  const s = clean({ kind: 'tiers', headline: '  Big   sale ', tiers: [{ spend: '$1,000', percent: '20%' }, { spend: 'abc', percent: 2.5 }], hack: 1 });
  assert.equal(s.headline, 'Big sale');
  assert.deepEqual(s.tiers, [{ spend: 1000, percent: 20 }, { spend: null, percent: null }]);
  assert.equal('hack' in s, false);
  assert.equal(clean({ kind: 'nope' }).kind, '');
  assert.equal(clean({ link: 'https://www.sunnyandranney.com/shop/?sale=true' }).link, '/shop/?sale=true');
  assert.equal(clean({ link: 'https://sunnyandranney.com' }).link, '/');
});

test('a good tiered special has nothing wrong with it', () => {
  assert.deepEqual(check(tiers([{ spend: 250, percent: 10 }, { spend: 500, percent: 15 }, { spend: 1000, percent: 20 }]), SEND), {});
});

test('tiers need round, growing amounts and growing percents, 2 to 4 of them', () => {
  const e = check(tiers([{ spend: 260, percent: 10 }, { spend: 250, percent: 10 }, { spend: null, percent: 95 }]), SEND);
  assert.match(e['tiers.0.spend'], /multiple of \$50/);
  assert.match(e['tiers.1.percent'], /bigger percent than the one above it \(10%\)/);
  assert.match(e['tiers.2.spend'], /Add how much/);
  assert.match(e['tiers.2.percent'], /from 1 to 90/);
  assert.match(check(tiers([{ spend: 500, percent: 10 }, { spend: 250, percent: 15 }]), SEND)['tiers.1.spend'], /bigger amount than the one above it \(\$500\)/);
  assert.match(check(tiers([{ spend: 250, percent: 10 }]), SEND).tiers, /at least 2/);
  const five = Array.from({ length: 5 }, (_, k) => ({ spend: 250 * (k + 1), percent: 5 * (k + 1) }));
  assert.match(check(tiers(five), SEND).tiers, /4 tiers at most/);
  assert.match(check(tiers([{ spend: 25, percent: 5 }, { spend: 60000, percent: 10 }]), SEND)['tiers.0.spend'], /from \$50 to \$50,000/);
});

test('each kind asks only for what it needs', () => {
  assert.match(check(percent({ percent: '' }), SEND).percent, /Add the percent/);
  assert.match(check(percent({ what: '' }), SEND).what, /what it’s off/);
  assert.deepEqual(check(percent(), SEND), {});
  assert.match(check(clean({ kind: 'headline' }), SEND).headline, /Add the headline/);
  // A headline week has no discount, so it has no terms to give
  assert.deepEqual(check(clean({ kind: 'headline', headline: 'Hi' }), SEND), {});
  assert.match(check(clean({}), SEND).kind, /Pick what kind/);
  assert.match(check(clean({ kind: 'headline', headline: 'x'.repeat(71) }), SEND).headline, /70 characters at most. This one is 71/);
});

test('the button only goes to pages on the store’s site', () => {
  const link = (l) => check(clean({ kind: 'headline', headline: 'Hi', link: l }), SEND).link;
  assert.equal(link('/shop/?sale=true'), undefined);
  assert.match(link('//evil.example'), /starting with \//);
  assert.match(link('javascript:alert(1)'), /starting with \//);
  assert.match(link('https://other.example/x'), /starting with \//);
});

test('a discount can’t be saved without where it applies and when it ends', () => {
  for (const s of [tiers([{ spend: 250, percent: 10 }, { spend: 500, percent: 15 }], { where: '', ends: '' }), percent({ where: '', ends: '' })]) {
    const e = check(s, SEND);
    assert.match(e.where, /where the sale applies/);
    assert.match(e.ends, /last day of the sale/);
  }
  assert.equal(clean({ where: 'everywhere' }).where, '', 'only the three choices count');
});

test('an end date has to fall after the email goes out, and not too far after', () => {
  const ends = (d) => check(percent({ ends: d }), SEND).ends;
  assert.equal(ends('2026-11-22'), undefined);
  assert.match(ends('2026-11-16'), /before the email goes out/);
  assert.match(ends('2027-02-01'), /within 60 days/);
  assert.match(ends('2026-02-30'), /isn’t a date/);
});

test('the offer gets the store’s defaults, curly quotes and safe HTML', () => {
  const sale = toSale(percent());
  assert.deepEqual(sale, { kind: 'percent', name: 'Storewide sale', cta: 'Shop the sale', url: '/shop/', percent: 20, what: 'everything.', details: 'In the showroom and online. Ends Sunday, Nov 29.' });
  assert.equal(toSale(percent({ percent: 15, what: 'all rugs!' })).name, 'This week’s sale');
  assert.equal(toSale(percent({ percent: 15, what: 'all rugs!' })).what, 'all rugs!');
  assert.equal(toSale(percent({ percent: 15, what: 'all rugs!' })).url, '/shop/?sale=true');
  const h = toSale(clean({ kind: 'headline', headline: `Kids' crafts & "Santa Paws" <3`, details: 'Free gift wrap all week.' }));
  assert.equal(h.headline, 'Kids&#8217; crafts &amp; &#8220;Santa Paws&#8221; &lt;3');
  assert.equal(h.details, 'Free gift wrap all week.');
  assert.equal(h.url, '/shop/?collection=new-arrivals');
  assert.equal(h.cta, 'See what’s new');
  assert.equal(typeset("'Tis the season"), '&#8216;Tis the season');
});

test('the subject and preheader can only promise what the offer gives', () => {
  const sale = { kind: 'tiers', tiers: [[250, 10], [500, 15], [1000, 20]] };
  // {offer} and {upto} are written from the offer, so Staci's numbers never need typing twice
  assert.deepEqual(lines({ sale, subject: 'Save Up to {upto}!', preheader: '{offer} Plus crafts.' }), {
    subject: 'Save Up to 20%!',
    preheader: 'Spend $250, save 10%. Spend $1,000, save 20%. Plus crafts.',
  });
  assert.equal(offerLine({ kind: 'percent', percent: 20, what: 'everything.' }), '20% off everything.');
  // The lines the Nov 17 stress tests carried before this check: tiers of $500/10% and $1,500/25%
  const two = { kind: 'tiers', tiers: [[500, 10], [1500, 25]] };
  const said = offerClaims('Spend $250, save 10%. Spend $1,000, save 20%. Save Up to 20%', two, 'preheader');
  assert.ok(said.includes('The preheader says 20%, but the sale gives 10%, 25%.'));
  assert.ok(said.includes('The preheader says up to 20%, but the most the sale gives is 25%.'));
  assert.ok(said.includes('The preheader says $250, but the tiers are $500, $1,500.'));
  assert.deepEqual(offerClaims('Spend $500, save 15%.', two, 'preheader'), ['The preheader says 15%, but the sale gives 10%, 25%.', 'The preheader pairs $500 with 15%, but that tier gives 10%.']);
  assert.deepEqual(offerClaims('Spend $500, save 25%.', two, 'preheader'), ['The preheader pairs $500 with 25%, but that tier gives 10%.']);
  assert.deepEqual(offerClaims('Save 10% on $500 up to 25% on $1.5k', two, 'preheader'), []);
  assert.deepEqual(offerClaims('Save 25% on $500', two, 'preheader'), ['The preheader pairs $500 with 25%, but that tier gives 10%.']);
  // A share isn't a discount, and a quiet week can't promise one
  assert.deepEqual(offerClaims('100% of our profits fund dream rooms', two, 'subject'), []);
  assert.deepEqual(offerClaims('Up to 30% off!', { kind: 'headline', headline: 'Hi' }, 'subject'), ['The subject says 30%, but this week has no discount.']);
  assert.throws(() => lines({ sale: { kind: 'headline' }, subject: 'Save {upto}', preheader: '' }), /asks for \{upto\}, but this week has no discount/);
  assert.throws(() => render({ send_date: SEND, sale, subject: 'Save 25% today', preheader: '' }, ['masthead']), /subject says 25%/);
});

test('spend more, save more counts the whole order, so its button opens the whole shop', () => {
  const t = toSale(tiers([{ spend: 250, percent: 10 }, { spend: 500, percent: 15 }]));
  assert.equal(t.url, '/shop/');
  assert.equal(toSale(tiers([{ spend: 250, percent: 10 }, { spend: 500, percent: 15 }], { link: '/shop/?sale=true' })).url, '/shop/?sale=true', 'Staci can still pick another page');
});

test('the fine print gives the terms first, then anything Staci added', () => {
  assert.equal(termsLine(percent({ where: 'store' })), 'In the showroom only. Ends Sunday, Nov 29.');
  assert.equal(termsLine(percent({ where: 'online', ends: '2026-11-22' })), 'Online only. Ends Sunday, Nov 22.');
  assert.equal(toSale(percent({ details: 'Can’t be combined with other offers.' })).details, 'In the showroom and online. Ends Sunday, Nov 29. Can’t be combined with other offers.');
  // Old headline specials saved an end date; a headline week has no terms, so it's left out
  assert.equal(termsLine(clean({ kind: 'headline', headline: 'Hi', where: 'both', ends: '2026-11-22' })), '');
});

test('saving keeps only the kind’s own fields', () => {
  const s = clean({ ...blank('percent'), percent: 20, headline: 'left over from tiers' });
  assert.deepEqual(Object.keys(forKind(s)).sort(), ['cta', 'details', 'ends', 'kind', 'label', 'link', 'percent', 'what', 'where']);
  assert.deepEqual(Object.keys(forKind(clean({ ...blank('headline'), headline: 'Hi', ends: '2026-11-22' }))).sort(), ['cta', 'details', 'headline', 'kind', 'label', 'link']);
});

test('the preview draws an unfinished special without breaking', () => {
  const sale = draftSale(clean(blank('tiers')));
  assert.deepEqual(sale.tiers, [['?', '?'], ['?', '?']]);
  assert.equal(sale.headline, 'Your headline');
  const html = render(previewBrief(sale, SEND), ['masthead', 'hero', 'offer']);
  assert.match(html, /\?% off|>\?%</);
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(render(previewBrief(draftSale(clean(blank('percent'))), SEND), ['offer']), /\?%&nbsp;off/);
});

test('summary reads each kind in one line', () => {
  assert.equal(summary(tiers([{ spend: 250, percent: 10 }, { spend: 1000, percent: 20 }])), '10% off $250+ · 20% off $1,000+');
  assert.equal(summary(percent()), '20% off everything');
});

test('the email goes out on Tuesdays', () => {
  assert.equal(nextSend('2026-11-11'), '2026-11-17');
  assert.equal(nextSend('2026-11-17'), '2026-11-17');
  assert.equal(nextSend('2026-11-15'), '2026-11-17');
  assert.deepEqual(upcomingSends('2026-11-11', 3), ['2026-11-17', '2026-11-24', '2026-12-01']);
  assert.equal(isSendDate('2026-11-17'), true);
  assert.equal(isSendDate('2026-11-18'), false);
  assert.equal(isSendDate('2026-13-01'), false);
  assert.equal(sendLabel('2026-11-17'), 'Tue, Nov 17');
});

// ─── Real D1 (Miniflare's local SQLite) ──────────────────────────────
let dbCount = 0;
async function freshDb() {
  const mf = new Miniflare({ modules: true, script: 'export default {}', d1Databases: { DB: `special-test-${dbCount++}` } });
  return { DB: await mf.getD1Database('DB'), mf };
}

test('saving checks the version the page loaded, so nobody overwrites anybody', async () => {
  const { DB, mf } = await freshDb();
  try {
    const special = forKind(clean({ kind: 'percent', percent: 20, what: 'everything' }));
    const first = await putSpecial(DB, { send: SEND, special, by: 'staci@x', now: '2026-11-11T15:00:00Z', since: null });
    assert.equal(first.ok, true);
    // A second "first save" (another manager's page loaded before the first save) is refused
    const late = await putSpecial(DB, { send: SEND, special, by: 'mike@x', now: '2026-11-11T15:01:00Z', since: null });
    assert.equal(late.ok, false);
    assert.equal(late.current.updatedBy, 'staci@x');
    const edit = await putSpecial(DB, { send: SEND, special: { ...special, percent: 25 }, by: 'staci@x', now: '2026-11-11T15:02:00Z', since: '2026-11-11T15:00:00Z' });
    assert.equal(edit.ok, true);
    const stale = await putSpecial(DB, { send: SEND, special, by: 'mike@x', now: '2026-11-11T15:03:00Z', since: '2026-11-11T15:00:00Z' });
    assert.equal(stale.ok, false);
    assert.equal((await getSpecial(DB, SEND)).special.percent, 25);
    assert.equal((await clearSpecial(DB, { send: SEND, since: '2026-11-11T15:00:00Z' })).ok, false);
    assert.equal((await clearSpecial(DB, { send: SEND, since: '2026-11-11T15:02:00Z' })).ok, true);
    assert.equal(await getSpecial(DB, SEND), null);
  } finally {
    await mf.dispose();
  }
});

test('past specials come newest first; a range comes in order', async () => {
  const { DB, mf } = await freshDb();
  try {
    const special = forKind(clean({ kind: 'headline', headline: 'Hi' }));
    for (const send of ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24']) await putSpecial(DB, { send, special, by: 'staci@x', now: send, since: null });
    assert.deepEqual((await pastSpecials(DB, '2026-11-17')).map((r) => r.send), ['2026-11-10', '2026-11-03']);
    assert.deepEqual((await specialsBetween(DB, '2026-11-10', '2026-11-24')).map((r) => r.send), ['2026-11-10', '2026-11-17', '2026-11-24']);
  } finally {
    await mf.dispose();
  }
});

// ─── The charity's section ───────────────────────────────────────────
test('impact numbers come from the charity page, and anything unexpected stops the build', () => {
  const page = '<div><span>295+</span><span>Room Makeovers</span></div><div><b>208+</b> <i>Children Served</i></div><p>295+ Room Makeovers</p>';
  assert.deepEqual(impactFromPage(page), { rooms: '295+', children: '208+' });
  assert.throws(() => impactFromPage('<p>295+ Room Makeovers</p>'), /one "Children Served" number on the page, found none/);
  assert.throws(() => impactFromPage('<p>295+ Room Makeovers</p><p>300+ Room Makeovers</p><p>208+ Children Served</p>'), /found 295\+, 300\+/);
});

test('the charity section shows its live numbers, and leaves the strip out without them', () => {
  const brief = {
    send_date: SEND,
    mission: { photo: { src: 'cf:x.jpg', alt: 'A family' }, caption: 'Ages 14 and 12.', story: 'Story.', cta: 'See their reveal', url: 'https://sunshineonaranneyday.com/kids/x/', impact: { rooms: '295+', children: '208+' } },
  };
  const html = new Email(brief).mission();
  // The logo on its own Warm Gray tile (readable when dark mode darkens the band), in a row whose
  // padding is short by the tile's margin so the lettering stays on the column
  assert.match(html, /class="soard ptl pxl"[^>]*padding:34px 26px 0px;/);
  assert.match(html, /soard-logo-warm-tile\/public" width="132" height="121"/);
  assert.match(html, /class="px pb soard"[^>]*padding:18px 32px 40px;/);
  assert.match(html, />295\+</);
  assert.match(html, />208\+</);
  assert.match(html, /\$0</);
  assert.match(html, /utm_content=charity-logo/);
  const none = new Email({ ...brief, mission: { ...brief.mission, impact: undefined } }).mission();
  assert.doesNotMatch(none, /Room makeovers/);
});
