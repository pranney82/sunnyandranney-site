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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/**
 * Fetch store hours from Google Places API (New) at build time.
 * Uses `currentOpeningHours` which includes holiday/special overrides,
 * falling back to `regularOpeningHours` for the base weekly schedule.
 */
export async function fetchGoogleHours(): Promise<GooglePlaceHours | null> {
  if (_hoursCache !== undefined) return _hoursCache;

  const apiKey = import.meta.env.GOOGLE_PLACES_API_KEY;
  const placeId = import.meta.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    _hoursCache = null;
    return null;
  }

  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'regularOpeningHours,currentOpeningHours',
        },
      },
    );

    if (!res.ok) {
      console.warn(`[google-hours] API returned ${res.status}`);
      _hoursCache = null;
      return null;
    }

    const data = await res.json() as {
      regularOpeningHours?: GoogleOpeningHours;
      currentOpeningHours?: GoogleOpeningHours;
    };

    // currentOpeningHours includes holiday overrides; regularOpeningHours is the base
    const current = data.currentOpeningHours;
    const regular = data.regularOpeningHours;

    if (!regular?.periods?.length) {
      console.warn('[google-hours] No opening hours data returned');
      _hoursCache = null;
      return null;
    }

    // Build weekly schedule from regular hours
    const dayMap = new Map<number, { open: string; close: string }>();
    for (const period of regular.periods) {
      const dayNum = period.open.day;
      const openTime = padTime(period.open.hour, period.open.minute);
      const closeTime = period.close
        ? padTime(period.close.hour, period.close.minute)
        : '23:59';
      dayMap.set(dayNum, { open: openTime, close: closeTime });
    }

    // Output days Monday–Sunday (shift Sunday to end)
    const orderedDays = [1, 2, 3, 4, 5, 6, 0];
    const days = orderedDays.map(dayNum => {
      const times = dayMap.get(dayNum);
      return {
        day: DAY_NAMES[dayNum],
        open: times?.open ?? '00:00',
        close: times?.close ?? '00:00',
        closed: !times,
      };
    });

    // Detect holiday/special hours from currentOpeningHours.
    // specialDays lists dates with exceptional hours (e.g. Christmas).
    // Match each against currentOpeningHours.periods by calendar date to
    // find actual hours; if no period matches, the store is closed that day.
    const holidays: GooglePlaceHours['holidays'] = [];
    if (current?.specialDays) {
      for (const special of current.specialDays) {
        if (!special.date) continue;
        const dateStr = `${special.date.year}-${String(special.date.month).padStart(2, '0')}-${String(special.date.day).padStart(2, '0')}`;
        const d = new Date(dateStr + 'T12:00:00');
        const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        // Match by specific calendar date, not day-of-week
        const matchingPeriod = current.periods?.find(p =>
          p.open.date &&
          p.open.date.year === special.date!.year &&
          p.open.date.month === special.date!.month &&
          p.open.date.day === special.date!.day
        );

        if (matchingPeriod) {
          holidays.push({
            date: dateStr,
            label,
            closed: false,
            open: padTime(matchingPeriod.open.hour, matchingPeriod.open.minute),
            close: matchingPeriod.close
              ? padTime(matchingPeriod.close.hour, matchingPeriod.close.minute)
              : '23:59',
          });
        } else {
          // No period for this date → store is closed
          holidays.push({ date: dateStr, label, closed: true, open: '00:00', close: '00:00' });
        }
      }
    }

    _hoursCache = { days, holidays, note: '' };
    console.log('[google-hours] Fetched live store hours from Google Places API');
    return _hoursCache;
  } catch (err) {
    console.warn('[google-hours] Fetch failed:', err);
    _hoursCache = null;
    return null;
  }
}

interface GoogleDate {
  year: number;
  month: number;
  day: number;
}

interface GoogleOpeningHours {
  periods?: Array<{
    open: { date?: GoogleDate; day: number; hour: number; minute: number };
    close?: { date?: GoogleDate; day: number; hour: number; minute: number };
  }>;
  specialDays?: Array<{
    date?: GoogleDate;
  }>;
}

function padTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export async function fetchGooglePlaceData(): Promise<GooglePlaceData | null> {
  if (_cache !== undefined) return _cache;

  const apiKey = import.meta.env.GOOGLE_PLACES_API_KEY;
  const placeId = import.meta.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    _cache = null;
    return null;
  }

  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'rating,userRatingCount,reviews',
        },
      },
    );

    if (!res.ok) {
      console.warn(`Google Places API returned ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      rating?: number;
      userRatingCount?: number;
      reviews?: Array<{
        authorAttribution?: {
          displayName?: string;
          photoUri?: string;
        };
        text?: { text?: string };
        rating?: number;
        relativePublishTimeDescription?: string;
      }>;
    };

    const reviews = (data.reviews ?? []).filter((r) => r.text?.text);

    const cfAccountId = import.meta.env.CF_ACCOUNT_ID;
    const cfImagesToken = import.meta.env.CF_IMAGES_TOKEN;

    const reviewsWithPhotos = await Promise.all(
      reviews.map(async (r, i) => {
        let photoUrl = '';
        const uri = r.authorAttribution?.photoUri;
        if (uri) {
          try {
            const smallUri = uri.replace(/=s\d+/, '=s80');
            const imgRes = await fetch(smallUri);
            if (imgRes.ok) {
              const buf = Buffer.from(await imgRes.arrayBuffer());

              // Upload to CF Images if credentials are available
              if (cfAccountId && cfImagesToken) {
                const form = new FormData();
                form.append('file', new Blob([buf]), `review-avatar-${i}`);
                form.append('id', `review-avatar-${i}`);
                const cfRes = await fetch(
                  `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/images/v1`,
                  { method: 'POST', headers: { Authorization: `Bearer ${cfImagesToken}` }, body: form },
                );
                const cfBody = await cfRes.json() as { success: boolean; errors?: Array<{ code: number }> };
                const alreadyExists = cfBody.errors?.some((e) => e.code === 5409);
                if (cfBody.success || alreadyExists) {
                  photoUrl = `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/review-avatar-${i}/w=80,h=80,fit=cover,format=auto`;
                }
              }
            }
          } catch {
            // skip — will fall back to initials
          }
        }
        return {
          name: r.authorAttribution?.displayName ?? 'Anonymous',
          text: r.text!.text!,
          rating: r.rating ?? 5,
          photoUrl,
          timeAgo: r.relativePublishTimeDescription ?? '',
        };
      }),
    );

    _cache = {
      rating: data.rating ?? 5.0,
      reviewCount: data.userRatingCount ?? 0,
      reviews: reviewsWithPhotos,
    };
    return _cache;
  } catch (err) {
    console.warn('Google Places API fetch failed:', err);
    _cache = null;
    return null;
  }
}
