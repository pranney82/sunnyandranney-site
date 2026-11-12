import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { ICONS, PHONE_TABS, SIDEBAR, allLinks, currentHref, navFor, phoneNav, sidebarHeight } from './nav.mjs';

const PAGES = new URL('../../pages/', import.meta.url);
const LAYOUT = readFileSync(new URL('../../layouts/AdminBase.astro', import.meta.url), 'utf8');

/** Every page file under src/pages/admin, as the path it serves ([id] becomes x). */
function adminRoutes(dir = new URL('admin/', PAGES), base = '/admin/') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return adminRoutes(new URL(`${entry.name}/`, dir), `${base}${entry.name.replace(/\[.*\]/, 'x')}/`);
    if (!entry.name.endsWith('.astro')) return [];
    const source = readFileSync(new URL(entry.name, dir), 'utf8');
    const name = entry.name.replace(/\.astro$/, '').replace(/\[.*\]/, 'x');
    return [{ route: name === 'index' ? base : `${base}${name}/`, redirect: source.includes('Astro.redirect(') && !source.includes('<AdminBase') }];
  });
}

const PEOPLE = {
  owner: { role: 'manager', owner: true },
  manager: { role: 'manager', owner: false },
  'store tablet': { role: 'kiosk', owner: false },
};

for (const [who, signIn] of Object.entries(PEOPLE)) {
  const nav = navFor(signIn);
  const links = allLinks(nav);

  test(`${who}: every link fits the sidebar on one screen, sub-pages open`, () => {
    const height = sidebarHeight(nav);
    assert.ok(
      height <= SIDEBAR.budget,
      `the ${who}'s sidebar needs ${height}px, over the ${SIDEBAR.budget}px budget. Put the new page under the page it belongs to, or merge a section.`,
    );
  });

  test(`${who}: every link has its own icon, so the phone's More sheet never shows two alike`, () => {
    for (const link of links) assert.ok(ICONS[link.icon], `${link.label} uses "${link.icon}", which isn't an icon`);
    const icons = links.map((link) => link.icon);
    assert.deepEqual(icons, [...new Set(icons)], `two of the ${who}'s links share an icon`);
  });

  test(`${who}: no page is listed twice`, () => {
    const hrefs = links.map((link) => link.href);
    assert.deepEqual(hrefs, [...new Set(hrefs)]);
  });

  test(`${who}: every link goes to a page that exists`, () => {
    for (const { href } of links) {
      const file = href.replace(/^\//, '').replace(/\/$/, '');
      assert.ok(existsSync(new URL(`${file}.astro`, PAGES)) || existsSync(new URL(`${file}/index.astro`, PAGES)), `${href} has no page`);
    }
  });

  test(`${who}: the phone has at most ${PHONE_TABS} tabs plus More, and every page is on it`, () => {
    const phone = phoneNav(nav, undefined);
    assert.ok(phone.tabs.length <= PHONE_TABS, `${phone.tabs.length} tabs`);
    assert.equal(phone.tabs.length + phone.groups.flat().length, links.length);
  });
}

test('every admin page lights up a link in the manager’s navigation', () => {
  const links = allLinks(navFor(PEOPLE.owner));
  for (const { route, redirect } of adminRoutes()) {
    if (!redirect) assert.ok(currentHref(route, links), `${route} has no link, so nothing in the sidebar shows where you are`);
  }
});

test('the layout sizes the sidebar from SIDEBAR, so the height model holds', () => {
  for (const name of ['--row', '--heading', '--section-gap', '--touch-row']) {
    assert.ok(LAYOUT.includes(`${name}:\${`), `the layout doesn't set ${name} from SIDEBAR`);
    assert.ok(LAYOUT.includes(`var(${name})`), `the layout's CSS doesn't use ${name}`);
  }
});

test('on the phone, a sub-page lights up its page’s tab, or More', () => {
  const nav = navFor(PEOPLE.owner);
  assert.deepEqual(pick(phoneNav(nav, '/admin/hours/history/')), { activeTab: '/admin/hours/', moreActive: false });
  assert.deepEqual(pick(phoneNav(nav, '/admin/buying/costs/')), { activeTab: undefined, moreActive: true });
  assert.deepEqual(pick(phoneNav(nav, '/admin/')), { activeTab: '/admin/', moreActive: false });
});

const pick = ({ activeTab, moreActive }) => ({ activeTab, moreActive });

test('a sub-page lives under its parent, so the parent opens on it', () => {
  for (const section of navFor(PEOPLE.owner).sections) {
    for (const link of section.links) {
      for (const child of link.children ?? []) assert.ok(child.href.startsWith(link.href), `${child.label} isn't under ${link.label}`);
    }
  }
});

test('the old flat sidebar fails the budget, which is how it grew a scrollbar', () => {
  const nav = navFor(PEOPLE.owner);
  const flat = { ...nav, sections: nav.sections.map((s) => ({ ...s, links: s.links.flatMap((l) => [{ ...l, children: undefined }, ...(l.children ?? [])]) })) };
  assert.ok(sidebarHeight(flat) > SIDEBAR.budget);
});

test('the current page is the deepest link the path starts with', () => {
  const links = allLinks(navFor(PEOPLE.owner));
  assert.equal(currentHref('/admin/', links), '/admin/');
  assert.equal(currentHref('/admin', links), '/admin/');
  assert.equal(currentHref('/admin/buying/', links), '/admin/buying/');
  assert.equal(currentHref('/admin/buying/po_123', links), '/admin/buying/');
  assert.equal(currentHref('/admin/buying/costs/', links), '/admin/buying/costs/');
  assert.equal(currentHref('/admin/hours/send', links), '/admin/hours/');
  assert.equal(currentHref('/admin/hours/history/', links), '/admin/hours/history/');
  assert.equal(currentHref('/admin/gusto/', links), '/admin/gusto/');
  assert.equal(currentHref('/admin/staff/abc', links), '/admin/staff/');
  assert.equal(currentHref('/admin/nowhere/', links), undefined);
});

test('settings is the owner’s alone', () => {
  assert.ok(navFor(PEOPLE.owner).settings);
  assert.equal(navFor(PEOPLE.manager).settings, undefined);
  assert.equal(navFor(PEOPLE['store tablet']).settings, undefined);
});

test('someone without a role gets no navigation', () => {
  assert.equal(allLinks(navFor({})).length, 0);
});
