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
  holidays: Array<{ date: string; label: string }>;
  note: string;
}

export interface CollectionSetting {
  handle: string;
  enabled: boolean;
  order: number;
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

// ─── Build-time readers (for static pages) ──────────────────

/**
 * Safely import a JSON settings file.
 * Returns null if the file doesn't exist (first deploy before any admin saves).
 */
async function loadLocalJson<T>(path: string): Promise<T | null> {
  try {
    // Vite glob import at build time — each file needs a static path
    const module = await import(/* @vite-ignore */ path);
    return (module.default ?? module) as T;
  } catch {
    return null;
  }
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

function abbrev(day: string): string {
  return day.slice(0, 3);
}

function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${m.toString().padStart(2, '0')}${suffix}`;
}
