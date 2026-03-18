/**
 * Build-time settings reader for static pages.
 *
 * Reads from local JSON files in src/content/settings/ that are committed
 * by the admin panel via GitHub API. Each commit triggers a CF Pages rebuild
 * so static pages pick up the new data.
 */

// ─── Types ──────────────────────────────────────────────────

export interface StoreHours {
  days: Array<{ day: string; open: string; close: string; closed: boolean }>;
  holidays: Array<{
    date: string;
    label: string;
    closed: boolean;
    open: string;
    close: string;
  }>;
  note: string;
}

export interface CollectionSetting {
  handle: string;
  enabled: boolean;
  order: number;
  showInNav?: boolean;
  navLabel?: string;
}

export interface StoreSpecials {
  promoCode: string;
  promoDescription: string;
  featuredHandle: string;
  announcements: Array<{
    id: string;
    text: string;
    link: string;
    active: boolean;
    type: 'banner' | 'promo' | 'info';
  }>;
}

export interface ContactInfo {
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
  instagramUrl: string;
  facebookUrl: string;
}

export interface EmailSignupConfig {
  constantContactListId: string;
  constantContactListName: string;
}

export interface TrendingSetting {
  handles: string[];
}

export interface HeroSetting {
  imageUrl: string;           // Shopify product image URL (or fallback CF Images URL)
  productHandle: string;      // Shopify product handle for the hero card
  collectionHandle?: string;  // Collection the product was picked from (admin state)
}

export interface KidStory {
  name: string;
  tag: string;
  blurb: string;
  imageUrl: string;        // CF Images base URL (no size params)
}

export interface KidsSetting {
  heading: string;
  subheading: string;
  kids: KidStory[];
}

export interface StaffPicksSetting {
  handles: string[];
}

export interface TeamMember {
  name: string;
  role: string;
  desc: string;
  imageUrl: string;        // CF Images base URL (no size params), empty for initials-only
  initials: string;        // e.g. "ST" — shown when no imageUrl
}

export interface TeamSetting {
  members: TeamMember[];
}

// ─── Setting key → type map ─────────────────────────────────

interface SettingsMap {
  'hours': StoreHours;
  'collections': CollectionSetting[];
  'specials': StoreSpecials;
  'contact': ContactInfo;
  'email-signup': EmailSignupConfig;
  'trending': TrendingSetting;
  'hero': HeroSetting;
  'kids': KidsSetting;
  'team': TeamSetting;
  'staff-picks': StaffPicksSetting;
}

// ─── Build-time reader ──────────────────────────────────────

// Vite's glob import — statically analyzable so it works in CF Pages production builds.
// Dynamic import(/* @vite-ignore */) is NOT bundled correctly in production.
const _settingsFiles = import.meta.glob('/src/content/settings/*.json', {
  eager: true,
  import: 'default',
});

/**
 * Read a settings JSON file bundled at build time.
 * Returns null if the file doesn't exist (first deploy before any admin saves).
 *
 * Synchronous — all JSON is eagerly loaded via Vite glob at bundle time.
 * Callers may `await` this safely (await on a non-Promise resolves immediately).
 */
function getSetting<K extends keyof SettingsMap>(key: K): SettingsMap[K] | null {
  const data = _settingsFiles[`/src/content/settings/${key}.json`];
  return data !== undefined ? (data as SettingsMap[K]) : null;
}

// Named exports for discoverability — thin wrappers over getSetting
export function getHoursStatic() { return getSetting('hours'); }
export function getCollectionsStatic() { return getSetting('collections'); }
export function getSpecialsStatic() { return getSetting('specials'); }
export function getContactStatic() { return getSetting('contact'); }
export function getEmailSignupStatic() { return getSetting('email-signup'); }
export function getTrendingStatic() { return getSetting('trending'); }
export function getHeroStatic() { return getSetting('hero'); }
export function getKidsStatic() { return getSetting('kids'); }
export function getTeamStatic() { return getSetting('team'); }
export function getStaffPicksStatic() { return getSetting('staff-picks'); }

// ─── Formatting helpers (shared by static pages + chatbot) ──

/** Format hours for display in the footer */
export function formatHoursShort(hours: StoreHours): string {
  const open = hours.days.filter(d => !d.closed);
  if (!open.length) return 'Currently closed';

  // Group consecutive days with same hours
  const groups: Array<{ days: string[]; open: string; close: string }> = [];
  for (const d of open) {
    const last = groups[groups.length - 1];
    if (last && last.open === d.open && last.close === d.close) {
      last.days.push(d.day);
    } else {
      groups.push({ days: [d.day], open: d.open, close: d.close });
    }
  }

  return groups.map(g => {
    const dayRange = g.days.length > 1
      ? `${abbrev(g.days[0])}–${abbrev(g.days[g.days.length - 1])}`
      : abbrev(g.days[0]);
    return `${dayRange} ${formatTime(g.open)}–${formatTime(g.close)}`;
  }).join(' · ');
}

/** Check if today (or a given date) is a holiday, and return its info */
export function getTodayHoliday(hours: StoreHours, dateStr?: string): StoreHours['holidays'][number] | null {
  const today = dateStr || new Date().toISOString().split('T')[0];
  return hours.holidays.find(h => h.date === today) || null;
}

/** Get upcoming holidays (next 30 days) for display */
export function getUpcomingHolidays(hours: StoreHours, limit = 3): Array<StoreHours['holidays'][number] & { formatted: string }> {
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + 30);

  const todayStr = today.toISOString().split('T')[0];
  const cutoffStr = cutoff.toISOString().split('T')[0];

  return hours.holidays
    .filter(h => h.date >= todayStr && h.date <= cutoffStr)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit)
    .map(h => {
      const d = new Date(h.date + 'T12:00:00');
      const dayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const timeLabel = h.closed ? 'Closed' : `${formatTime(h.open)}–${formatTime(h.close)}`;
      return { ...h, formatted: `${h.label} (${dayLabel}): ${timeLabel}` };
    });
}

/** Format a single holiday for inline display */
export function formatHolidayShort(h: StoreHours['holidays'][number]): string {
  if (h.closed) return `Closed for ${h.label}`;
  return `${h.label}: ${formatTime(h.open)}–${formatTime(h.close)}`;
}

function abbrev(day: string): string {
  return day.slice(0, 3);
}

function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${m.toString().padStart(2, '0')}${suffix}`;
}
