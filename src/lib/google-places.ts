/**
 * Fetches live review data from Google Places API (New) at build time.
 * Falls back gracefully if API key isn't set or the call fails.
 *
 * Required env vars (set in Cloudflare Pages dashboard):
 *   GOOGLE_PLACES_API_KEY — from Google Cloud Console (Places API New enabled)
 *   GOOGLE_PLACE_ID       — your Google Maps Place ID (e.g. ChIJ...)
 */

export interface GooglePlaceReview {
  name: string;
  text: string;
  rating: number;
  photoUrl: string;
  timeAgo: string;
}

export interface GooglePlaceData {
  rating: number;
  reviewCount: number;
  reviews: GooglePlaceReview[];
}

export interface GooglePlaceHours {
  days: Array<{ day: string; open: string; close: string; closed: boolean }>;
  holidays: Array<{ date: string; label: string; closed: boolean; open: string; close: string }>;
  note: string;
}

// Cache results so the API is only called once per build, not once per page
let _cache: GooglePlaceData | null | undefined;
let _hoursCache: GooglePlaceHours | null | undefined;

// Unified fetch — single API call for both reviews + hours
let _unifiedPromise: Promise<void> | null = null;

async function fetchUnified(): Promise<void> {
  const apiKey = import.meta.env.GOOGLE_PLACES_API_KEY;
  const placeId = import.meta.env.GOOGLE_PLACE_ID;
  if (!apiKey || !placeId) {
    _cache = null;
    _hoursCache = null;
    return;
  }

  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'rating,userRatingCount,reviews,regularOpeningHours,currentOpeningHours',
        },
      },
    );

    if (!res.ok) {
      console.warn(`[google-places] API returned ${res.status}`);
      _cache = null;
      _hoursCache = null;
      return;
    }

    const data = await res.json() as any;

    // Parse hours
    const regular = data.regularOpeningHours;
    const current = data.currentOpeningHours;
    if (regular?.periods?.length) {
      const dayMap = new Map<number, { open: string; close: string }>();
      for (const period of regular.periods) {
        dayMap.set(period.open.day, {
          open: padTime(period.open.hour, period.open.minute),
          close: period.close ? padTime(period.close.hour, period.close.minute) : '23:59',
        });
      }
      const orderedDays = [1, 2, 3, 4, 5, 6, 0];
      const days = orderedDays.map(dayNum => {
        const times = dayMap.get(dayNum);
        return { day: DAY_NAMES[dayNum], open: times?.open ?? '00:00', close: times?.close ?? '00:00', closed: !times };
      });
      const holidays: GooglePlaceHours['holidays'] = [];
      if (current?.specialDays) {
        for (const special of current.specialDays) {
          if (!special.date) continue;
          const dateStr = `${special.date.year}-${String(special.date.month).padStart(2, '0')}-${String(special.date.day).padStart(2, '0')}`;
          const d = new Date(dateStr + 'T12:00:00');
          const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
          const matchingPeriod = current.periods?.find((p: any) =>
            p.open.date && p.open.date.year === special.date!.year && p.open.date.month === special.date!.month && p.open.date.day === special.date!.day
          );
          if (matchingPeriod) {
            holidays.push({ date: dateStr, label, closed: false, open: padTime(matchingPeriod.open.hour, matchingPeriod.open.minute), close: matchingPeriod.close ? padTime(matchingPeriod.close.hour, matchingPeriod.close.minute) : '23:59' });
          } else {
            holidays.push({ date: dateStr, label, closed: true, open: '00:00', close: '00:00' });
          }
        }
      }
      _hoursCache = { days, holidays, note: '' };
      console.log('[google-places] Fetched live hours');
    } else {
      _hoursCache = null;
    }

    // Parse reviews
    const reviews = (data.reviews ?? []).filter((r: any) => r.text?.text);
    const cfAccountId = import.meta.env.CF_ACCOUNT_ID;
    const cfImagesToken = import.meta.env.CF_IMAGES_TOKEN;
    const reviewsWithPhotos = await Promise.all(
      reviews.map(async (r: any, i: number) => {
        let photoUrl = '';
        let uri = r.authorAttribution?.photoUri;
        if (uri) {
          try {
            if (uri.startsWith('//')) uri = `https:${uri}`;
            const smallUri = uri.replace(/=s\d+/, '=s80');
            const imgRes = await fetch(smallUri);
            if (imgRes.ok) {
              const buf = Buffer.from(await imgRes.arrayBuffer());
              if (cfAccountId && cfImagesToken) {
                const form = new FormData();
                form.append('file', new Blob([buf]), `review-avatar-${i}`);
                form.append('id', `review-avatar-${i}`);
                const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/images/v1`, { method: 'POST', headers: { Authorization: `Bearer ${cfImagesToken}` }, body: form });
                const cfBody = await cfRes.json() as { success: boolean; errors?: Array<{ code: number }> };
                if (cfBody.success || cfBody.errors?.some((e) => e.code === 5409)) {
                  photoUrl = `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/review-avatar-${i}/w=80,h=80,fit=cover,format=auto`;
                }
              }
              if (!photoUrl) photoUrl = smallUri;
            }
          } catch { /* skip — will fall back to initials */ }
        }
        return { name: r.authorAttribution?.displayName ?? 'Anonymous', text: r.text!.text!, rating: r.rating ?? 5, photoUrl, timeAgo: r.relativePublishTimeDescription ?? '' };
      }),
    );
    _cache = { rating: data.rating ?? 5.0, reviewCount: data.userRatingCount ?? 0, reviews: reviewsWithPhotos };
    console.log('[google-places] Fetched live reviews');
  } catch (err) {
    console.warn('[google-places] Fetch failed:', err);
    _cache = null;
    _hoursCache = null;
  }
}

function ensureUnifiedFetch(): Promise<void> {
  if (!_unifiedPromise) _unifiedPromise = fetchUnified();
  return _unifiedPromise;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function padTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Fetch store hours from Google Places API (New) at build time.
 * Uses the unified fetch so only one API call is made per build.
 */
export async function fetchGoogleHours(): Promise<GooglePlaceHours | null> {
  await ensureUnifiedFetch();
  return _hoursCache ?? null;
}

/**
 * Fetch reviews + rating from Google Places API (New) at build time.
 * Uses the unified fetch so only one API call is made per build.
 */
export async function fetchGooglePlaceData(): Promise<GooglePlaceData | null> {
  await ensureUnifiedFetch();
  return _cache ?? null;
}
