/**
 * Settings reader that works at both BUILD TIME and RUNTIME.
 *
 * - Static pages (build time): reads from local JSON files in src/content/settings/
 *   These files are committed by the admin panel via GitHub API, which triggers
 *   a CF Pages rebuild so static pages pick up the new data.
 *
 * - SSR pages (runtime): reads from D1 for sub-ms edge reads.
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

// ─── Build-time readers (for static pages) ──────────────────

// Vite's glob import — statically analyzable so it works in CF Pages production builds.
// Dynamic import(/* @vite-ignore */) is NOT bundled correctly in production.
const _settingsFiles = import.meta.glob('/src/content/settings/*.json', {
  eager: true,
  import: 'default',
});

/**
 * Safely read a settings JSON file bundled at build time.
 * Returns null if the file doesn't exist (first deploy before any admin saves).
 */
function loadLocalJson<T>(path: string): T | null {
  const data = _settingsFiles[path];
  return data !== undefined ? (data as T) : null;
}

export async function getHoursStatic(): Promise<StoreHours | null> {
  return loadLocalJson<StoreHours>('/src/content/settings/hours.json');
}

export async function getCollectionsStatic(): Promise<CollectionSetting[] | null> {
  return loadLocalJson<CollectionSetting[]>('/src/content/settings/collections.json');
}

export async function getSpecialsStatic(): Promise<StoreSpecials | null> {
  return loadLocalJson<StoreSpecials>('/src/content/settings/specials.json');
}

export async function getContactStatic(): Promise<ContactInfo | null> {
  return loadLocalJson<ContactInfo>('/src/content/settings/contact.json');
}

export async function getEmailSignupStatic(): Promise<EmailSignupConfig | null> {
  return loadLocalJson<EmailSignupConfig>('/src/content/settings/email-signup.json');
}

export async function getTrendingStatic(): Promise<TrendingSetting | null> {
  return loadLocalJson<TrendingSetting>('/src/content/settings/trending.json');
}

export async function getHeroStatic(): Promise<HeroSetting | null> {
  return loadLocalJson<HeroSetting>('/src/content/settings/hero.json');
}

export async function getKidsStatic(): Promise<KidsSetting | null> {
  return loadLocalJson<KidsSetting>('/src/content/settings/kids.json');
}

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
      let timeLabel: string;
      if (h.closed) {
        timeLabel = 'Closed';
      } else {
        timeLabel = `${formatTime(h.open)}–${formatTime(h.close)}`;
      }
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
