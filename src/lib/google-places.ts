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

// Cache the result so the API is only called once per build, not once per page
let _cache: GooglePlaceData | null | undefined;

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
