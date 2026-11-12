/**
 * The admin's navigation: which pages each role sees, how they nest, and how
 * tall the desktop sidebar is. AdminBase draws the sidebar and phone tab bar
 * from it, and nav.test.mjs keeps the sidebar on one screen as pages are added.
 *
 * The layout follows Shopify's admin, measured on the store's own account on
 * 2026-11-12: 30px rows, a page's sub-pages listed under it only while you're
 * in that part of the admin, Settings pinned to the foot.
 */

/** @typedef {'manager' | 'kiosk'} NavRole */

/**
 * @typedef {object} NavLink
 * @property {string} href
 * @property {string} label
 * @property {string} short Label under the icon on the phone tab bar.
 * @property {string} icon A key of ICONS. Sub-pages show theirs only in the phone's More sheet.
 * @property {boolean} [tab] False keeps a page off the phone tab bar; it's under More instead.
 * @property {NavLink[]} [children] Pages under this one, listed beneath it while you're in it.
 */

/** @typedef {{ heading: string, links: NavLink[] }} NavSection */
/** @typedef {{ sections: NavSection[], settings?: NavLink }} Nav */

/**
 * Feather line icons (MIT), drawn inline so the page needs no image requests.
 * @type {Record<string, string>}
 */
export const ICONS = {
  today: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  schedule: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  hours: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  history: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  staff: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  buying: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  costs: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  receive: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  vendors: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  email: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  payroll: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  tax: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  giving: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  signout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
};

/** Apple allows five tab bar items on iPhone, and More takes one. */
export const PHONE_TABS = 4;

/**
 * The pages a signed-in person sees. Managers get the whole admin, the owner
 * also gets Gusto settings, and the store tablet gets the clock and schedule.
 * @param {{ role?: NavRole, owner?: boolean }} who
 * @returns {Nav}
 */
export function navFor({ role, owner }) {
  if (role === 'kiosk') {
    return {
      sections: [
        {
          heading: 'Store',
          links: [
            { href: '/admin/clock/', label: 'Time clock', short: 'Clock', icon: 'clock' },
            { href: '/admin/schedule/', label: 'Schedule', short: 'Schedule', icon: 'schedule' },
          ],
        },
      ],
    };
  }
  if (role !== 'manager') return { sections: [] };
  return {
    sections: [
      {
        heading: 'Team',
        links: [
          { href: '/admin/', label: 'Today', short: 'Today', icon: 'today' },
          { href: '/admin/schedule/', label: 'Schedule', short: 'Schedule', icon: 'schedule' },
          {
            href: '/admin/hours/',
            label: 'Hours',
            short: 'Hours',
            icon: 'hours',
            children: [{ href: '/admin/hours/history/', label: 'Gusto history', short: 'History', icon: 'history', tab: false }],
          },
          { href: '/admin/clock/', label: 'Time clock', short: 'Clock', icon: 'clock', tab: false },
          { href: '/admin/staff/', label: 'Staff', short: 'Staff', icon: 'staff', tab: false },
        ],
      },
      {
        heading: 'Stock',
        links: [
          {
            href: '/admin/buying/',
            label: 'Purchase orders',
            short: 'Buying',
            icon: 'buying',
            tab: false,
            children: [{ href: '/admin/buying/costs/', label: 'Costs to match', short: 'Costs', icon: 'costs', tab: false }],
          },
          { href: '/admin/receiving/', label: 'Receiving', short: 'Receive', icon: 'receive', tab: false },
          { href: '/admin/vendors/', label: 'Vendors', short: 'Vendors', icon: 'vendors', tab: false },
        ],
      },
      {
        heading: 'Email',
        links: [{ href: '/admin/special/', label: 'Weekly special', short: 'Special', icon: 'email', tab: false }],
      },
      {
        heading: 'Pay',
        links: [
          { href: '/admin/payroll/', label: 'Payroll', short: 'Payroll', icon: 'payroll' },
          { href: '/admin/sales-tax/', label: 'Sales tax', short: 'Tax', icon: 'tax', tab: false },
          { href: '/admin/donations/', label: 'Donations', short: 'Giving', icon: 'giving', tab: false },
        ],
      },
    ],
    settings: owner ? { href: '/admin/gusto/', label: 'Gusto settings', short: 'Gusto', icon: 'settings', tab: false } : undefined,
  };
}

/**
 * Every link in sidebar order: each page followed by its sub-pages, then settings.
 * @param {Nav} nav
 * @returns {NavLink[]}
 */
export function allLinks(nav) {
  const links = nav.sections.flatMap((section) => section.links.flatMap((link) => [link, ...(link.children ?? [])]));
  return nav.settings ? [...links, nav.settings] : links;
}

/**
 * The link for the page at this path: the longest href it starts with, so a
 * purchase order's own page lights up Purchase orders. Today is /admin/ only.
 * @param {string} path
 * @param {NavLink[]} links
 * @returns {string | undefined}
 */
export function currentHref(path, links) {
  return links
    .filter((link) => (link.href === '/admin/' ? path === '/admin/' || path === '/admin' : path.startsWith(link.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

/**
 * The phone's tab bar: the pages marked as tabs, then More with the rest,
 * grouped by section. A sub-page lights up its page's tab when that page is a
 * tab (Gusto history lights Hours), and More otherwise.
 * @param {Nav} nav
 * @param {string | undefined} current The current page's href.
 */
export function phoneNav(nav, current) {
  const pages = nav.sections.flatMap((section) => section.links);
  const tabs = pages.filter((link) => link.tab !== false);
  // A sub-page follows its page in the sheet, or ends its group when its page is a tab.
  const groups = [
    ...nav.sections.map((section) => {
      const inSheet = section.links.filter((link) => link.tab === false).flatMap((link) => [link, ...(link.children ?? [])]);
      const underTabs = section.links.filter((link) => link.tab !== false).flatMap((link) => link.children ?? []);
      return [...inSheet, ...underTabs];
    }),
    nav.settings ? [nav.settings] : [],
  ].filter((group) => group.length > 0);
  const parent = pages.find((link) => link.children?.some((child) => child.href === current));
  const activeTab = tabs.find((tab) => tab.href === current || tab === parent)?.href;
  const moreActive = !activeTab && groups.flat().some((link) => link.href === current);
  return { tabs, groups, activeTab, moreActive };
}

/**
 * Desktop sidebar sizes in CSS px. AdminBase's CSS takes row, heading, gap and
 * touch row from here, so this model and the page can't drift apart. The frame
 * (padding, logo, search, signed-in row) and the settings row were measured in
 * Chrome on 2026-11-12, when the model matched the page to the pixel; a change
 * to the logo, search or footer needs them measured again.
 */
export const SIDEBAR = {
  /** One link with a mouse. Shopify's admin uses 30. */
  row: 30,
  /**
   * One link on a touch screen (an iPad in landscape), Apple's minimum target.
   * The list scrolls there, so the shell scrolls the current page into view and
   * fades the edge that has more.
   */
  touchRow: 44,
  /** A section label such as TEAM. */
  heading: 18,
  /** Space between sections. */
  gap: 12,
  /** Everything that isn't the link list. */
  frame: 156,
  /** The pinned settings link and the space above it. */
  settings: 34,
  /**
   * The shortest window every link must fit in, with no scrollbar. A 13-inch
   * MacBook Air shows about 747px of page in Chrome with the Dock; the
   * bookmarks bar takes about 28px more. Shorter windows scroll the list.
   */
  budget: 700,
};

/**
 * Height the desktop sidebar needs, with its longest list of sub-pages open.
 * @param {Nav} nav
 * @returns {number}
 */
export function sidebarHeight(nav) {
  const { sections, settings } = nav;
  if (sections.length === 0) return SIDEBAR.frame;
  const rows = sections.reduce((sum, section) => sum + section.links.length, 0);
  const mostChildren = Math.max(...sections.flatMap((section) => section.links.map((link) => link.children?.length ?? 0)));
  return (
    SIDEBAR.frame +
    (settings ? SIDEBAR.settings : 0) +
    (rows + mostChildren) * SIDEBAR.row +
    sections.length * SIDEBAR.heading +
    (sections.length - 1) * SIDEBAR.gap
  );
}
