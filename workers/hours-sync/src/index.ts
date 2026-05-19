/**
 * Cloudflare Worker — single source of truth for Google Places data.
 *
 * Cron: once daily, fetch hours + reviews + rating in ONE Places API call,
 * cache review avatars to Cloudflare Images, and upsert into D1.
 *
 * GET /: returns the cached blob as JSON — used by the static build so pages
 * never hit Google directly. Public; the data is already public.
 * POST /sync: manual sync trigger (X-Sync-Secret header required).
 *
 * Stale-while-revalidate: if Google errors, the existing D1 row is preserved.
 */

interface Env {
  DB: D1Database;
  GOOGLE_PLACES_API_KEY: string;
  GOOGLE_PLACE_ID: string;
  CF_ACCOUNT_ID?: string;
  CF_IMAGES_TOKEN?: string;
  SYNC_SECRET?: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

interface GoogleDate { year: number; month: number; day: number }
interface GooglePeriod {
  open: { date?: GoogleDate; day: number; hour: number; minute: number };
  close?: { date?: GoogleDate; day: number; hour: number; minute: number };
}
interface GoogleOpeningHours {
  periods?: GooglePeriod[];
  specialDays?: Array<{ date?: GoogleDate }>;
}

export interface PlaceHoursDay { day: string; open: string; close: string; closed: boolean }
export interface PlaceHoursHoliday { date: string; label: string; closed: boolean; open: string; close: string }
export interface PlaceHours { days: PlaceHoursDay[]; holidays: PlaceHoursHoliday[]; note: string }
export interface PlaceReview { name: string; text: string; rating: number; photoUrl: string; timeAgo: string }
export interface PlacesData { rating: number; reviewCount: number; reviews: PlaceReview[]; hours: PlaceHours | null }

function padTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseHours(regular?: GoogleOpeningHours, current?: GoogleOpeningHours): PlaceHours | null {
  if (!regular?.periods?.length) return null;

  const dayMap = new Map<number, { open: string; close: string }>();
  for (const period of regular.periods) {
    dayMap.set(period.open.day, {
      open: padTime(period.open.hour, period.open.minute),
      close: period.close ? padTime(period.close.hour, period.close.minute) : '23:59',
    });
  }

  const orderedDays = [1, 2, 3, 4, 5, 6, 0];
  const days: PlaceHoursDay[] = orderedDays.map(dayNum => {
    const times = dayMap.get(dayNum);
    return {
      day: DAY_NAMES[dayNum],
      open: times?.open ?? '00:00',
      close: times?.close ?? '00:00',
      closed: !times,
    };
  });

  const holidays: PlaceHoursHoliday[] = [];
  if (current?.specialDays) {
    for (const special of current.specialDays) {
      if (!special.date) continue;
      const dateStr = `${special.date.year}-${String(special.date.month).padStart(2, '0')}-${String(special.date.day).padStart(2, '0')}`;
      const d = new Date(dateStr + 'T12:00:00');
      const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const match = current.periods?.find(p =>
        p.open.date &&
        p.open.date.year === special.date!.year &&
        p.open.date.month === special.date!.month &&
        p.open.date.day === special.date!.day,
      );
      if (match) {
        holidays.push({
          date: dateStr, label, closed: false,
          open: padTime(match.open.hour, match.open.minute),
          close: match.close ? padTime(match.close.hour, match.close.minute) : '23:59',
        });
      } else {
        holidays.push({ date: dateStr, label, closed: true, open: '00:00', close: '00:00' });
      }
    }
  }

  return { days, holidays, note: '' };
}

async function cacheReviewAvatar(
  uri: string,
  index: number,
  accountId: string,
  imagesToken: string,
): Promise<string | null> {
  try {
    let url = uri;
    if (url.startsWith('//')) url = `https:${url}`;
    const smallUrl = url.replace(/=s\d+/, '=s80');
    const imgRes = await fetch(smallUrl);
    if (!imgRes.ok) return null;
    const buf = await imgRes.arrayBuffer();
    const form = new FormData();
    form.append('file', new Blob([buf]), `review-avatar-${index}`);
    form.append('id', `review-avatar-${index}`);
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
      { method: 'POST', headers: { Authorization: `Bearer ${imagesToken}` }, body: form },
    );
    const cfBody = await cfRes.json() as { success: boolean; errors?: Array<{ code: number }> };
    if (cfBody.success || cfBody.errors?.some(e => e.code === 5409)) {
      return `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/review-avatar-${index}/w=80,h=80,fit=cover,format=auto`;
    }
    return smallUrl;
  } catch {
    return null;
  }
}

async function syncFromGoogle(env: Env): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${env.GOOGLE_PLACE_ID}`, {
    headers: {
      'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'rating,userRatingCount,reviews,regularOpeningHours,currentOpeningHours',
    },
  });

  if (!res.ok) {
    return { ok: false, error: `Places API ${res.status}` };
  }

  const data = await res.json() as {
    rating?: number;
    userRatingCount?: number;
    reviews?: Array<{
      text?: { text?: string };
      rating?: number;
      relativePublishTimeDescription?: string;
      authorAttribution?: { displayName?: string; photoUri?: string };
    }>;
    regularOpeningHours?: GoogleOpeningHours;
    currentOpeningHours?: GoogleOpeningHours;
  };

  const hours = parseHours(data.regularOpeningHours, data.currentOpeningHours);
  const rawReviews = (data.reviews ?? []).filter(r => r.text?.text);

  const reviews: PlaceReview[] = await Promise.all(rawReviews.map(async (r, i) => {
    let photoUrl = '';
    const uri = r.authorAttribution?.photoUri;
    if (uri && env.CF_ACCOUNT_ID && env.CF_IMAGES_TOKEN) {
      photoUrl = (await cacheReviewAvatar(uri, i, env.CF_ACCOUNT_ID, env.CF_IMAGES_TOKEN)) ?? '';
    } else if (uri) {
      photoUrl = uri.startsWith('//') ? `https:${uri}` : uri;
    }
    return {
      name: r.authorAttribution?.displayName ?? 'Anonymous',
      text: r.text!.text!,
      rating: r.rating ?? 5,
      photoUrl,
      timeAgo: r.relativePublishTimeDescription ?? '',
    };
  }));

  const places: PlacesData = {
    rating: data.rating ?? 5.0,
    reviewCount: data.userRatingCount ?? 0,
    reviews,
    hours,
  };

  // Single write of the unified blob; also keep settings:hours for backwards-compat
  // with code that reads it directly (Staci chatbot, etc.).
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('settings:places', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(JSON.stringify(places)),
    ...(hours ? [env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('settings:hours', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(JSON.stringify(hours))] : []),
  ]);

  return { ok: true };
}

async function readCachedPlaces(db: D1Database): Promise<PlacesData | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'settings:places'")
    .first<{ value: string }>();
  if (!row) return null;
  try { return JSON.parse(row.value) as PlacesData; } catch { return null; }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.GOOGLE_PLACES_API_KEY || !env.GOOGLE_PLACE_ID) {
      console.error('[places-sync] Missing GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID');
      return;
    }
    ctx.waitUntil(syncFromGoogle(env).then(r => {
      if (!r.ok) console.warn(`[places-sync] cron sync skipped: ${r.error}`);
      else console.log('[places-sync] cron sync complete');
    }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/data')) {
      const cached = await readCachedPlaces(env.DB);
      return new Response(JSON.stringify(cached ?? {}), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/sync') {
      if (!env.SYNC_SECRET || request.headers.get('x-sync-secret') !== env.SYNC_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (!env.GOOGLE_PLACES_API_KEY || !env.GOOGLE_PLACE_ID) {
        return new Response('Missing secrets', { status: 500 });
      }
      const r = await syncFromGoogle(env);
      return new Response(JSON.stringify(r), {
        status: r.ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
