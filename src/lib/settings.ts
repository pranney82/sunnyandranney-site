/**
 * Build-time settings reader for static pages.
 *
 * Reads from Astro Content Collections (src/content/settings/*.json).
 * Each JSON file is committed to the repo — editing triggers a CF Pages rebuild
 * so static pages always serve the latest data.
 *
 * Each getter validates its data against a Zod schema for type-safe access
 * with clear build-time error messages on malformed files.
 */
import { getEntry } from 'astro:content';
import { z } from 'astro:content';
import { fetchGoogleHours } from '@/lib/google-places';

// ─── Zod Schemas ────────────────────────────────────────────

const daySchema = z.object({
  day: z.string(),
  open: z.string(),
  close: z.string(),
  closed: z.boolean(),
});

const holidaySchema = z.object({
  date: z.string(),
  label: z.string(),
  closed: z.boolean(),
  open: z.string(),
  close: z.string(),
});

const storeHoursSchema = z.object({
  days: z.array(daySchema),
  holidays: z.array(holidaySchema),
  note: z.string(),
});

const collectionSettingSchema = z.object({
  handle: z.string(),
  enabled: z.boolean(),
  order: z.number(),
  showInNav: z.boolean().optional(),
  navLabel: z.string().optional(),
});

const announcementSchema = z.object({
  id: z.string(),
  text: z.string(),
  link: z.string(),
  active: z.boolean(),
  type: z.enum(['banner', 'promo', 'info']),
});

const storeSpecialsSchema = z.object({
  promoCode: z.string(),
  promoDescription: z.string(),
  featuredHandle: z.string(),
  announcements: z.array(announcementSchema),
});

const contactInfoSchema = z.object({
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  phone: z.string(),
  email: z.string(),
  instagramUrl: z.string(),
  facebookUrl: z.string(),
});

const emailSignupConfigSchema = z.object({
  constantContactListId: z.string(),
  constantContactListName: z.string(),
});

const heroSettingSchema = z.object({
  imageUrl: z.string(),
  productHandle: z.string(),
  collectionHandle: z.string().optional(),
});

const kidStorySchema = z.object({
  name: z.string(),
  tag: z.string(),
  blurb: z.string(),
  imageUrl: z.string(),
});

const kidsSettingSchema = z.object({
  heading: z.string(),
  subheading: z.string(),
  kids: z.array(kidStorySchema),
});

const teamMemberSchema = z.object({
  name: z.string(),
  role: z.string(),
  desc: z.string(),
  imageUrl: z.string(),
  initials: z.string(),
});

const teamSettingSchema = z.object({
  members: z.array(teamMemberSchema),
});

const reviewItemSchema = z.object({
  name: z.string(),
  text: z.string(),
  rating: z.number(),
});

const reviewsSettingSchema = z.object({
  googleRating: z.number(),
  reviewCount: z.number(),
  featured: z.array(reviewItemSchema),
});

// ─── Exported Types (inferred from Zod) ─────────────────────

export type StoreHours = z.infer<typeof storeHoursSchema>;
export type CollectionSetting = z.infer<typeof collectionSettingSchema>;
export type StoreSpecials = z.infer<typeof storeSpecialsSchema>;
export type ContactInfo = z.infer<typeof contactInfoSchema>;
export type EmailSignupConfig = z.infer<typeof emailSignupConfigSchema>;
export type HeroSetting = z.infer<typeof heroSettingSchema>;
export type KidStory = z.infer<typeof kidStorySchema>;
export type KidsSetting = z.infer<typeof kidsSettingSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamSetting = z.infer<typeof teamSettingSchema>;
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type ReviewsSetting = z.infer<typeof reviewsSettingSchema>;

// ─── Typed getters via Content Collections ──────────────────

/**
 * Read and validate a settings entry from the content collection.
 * Returns null if the file doesn't exist or fails validation.
 */
async function getSettingValidated<T>(
  id: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const entry = await getEntry('settings', id);
    if (!entry) return null;
    const result = schema.safeParse(entry.data);
    if (!result.success) {
      console.error(`[settings] Invalid ${id}.json:`, result.error.issues);
      return null;
    }
    return result.data;
  } catch (err) {
    console.error(`[settings] Error reading ${id}:`, err);
    return null;
  }
}

export async function getHoursStatic(): Promise<StoreHours | null> {
  // Try Google Places API first (live hours including holiday overrides)
  const googleHours = await fetchGoogleHours();
  if (googleHours) {
    const result = storeHoursSchema.safeParse(googleHours);
    if (result.success) return result.data;
    console.warn('[settings] Google hours failed validation, falling back to hours.json');
  }
  // Fall back to committed hours.json
  return getSettingValidated('hours', storeHoursSchema);
}

export function getCollectionsStatic() {
  return getSettingValidated('collections', z.array(collectionSettingSchema));
}

export function getSpecialsStatic() {
  return getSettingValidated('specials', storeSpecialsSchema);
}

export function getContactStatic() {
  return getSettingValidated('contact', contactInfoSchema);
}

export function getEmailSignupStatic() {
  return getSettingValidated('email-signup', emailSignupConfigSchema);
}

export function getHeroStatic() {
  return getSettingValidated('hero', heroSettingSchema);
}

export function getKidsStatic() {
  return getSettingValidated('kids', kidsSettingSchema);
}

export function getTeamStatic() {
  return getSettingValidated('team', teamSettingSchema);
}

export function getReviewsStatic() {
  return getSettingValidated('reviews', reviewsSettingSchema);
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
