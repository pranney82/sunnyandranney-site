/**
 * Build-time reader for Google Places data, served from the hours-sync worker.
 *
 * The worker fetches Google Places once daily and caches the result in D1 + CF
 * Images. This module pulls from the worker — never from Google — so deploys
 * cost nothing in Places API charges and never block on Google availability.
 *
 * Required env var:
 *   PLACES_DATA_URL — public URL of the hours-sync worker
 *                     (e.g. https://hours-sync.<subdomain>.workers.dev)
 *
 * Returns null on any failure; callers already fall back to committed JSON.
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

interface PlacesBlob {
  rating?: number;
  reviewCount?: number;
  reviews?: GooglePlaceReview[];
  hours?: GooglePlaceHours | null;
}

let _blobPromise: Promise<PlacesBlob | null> | null = null;

async function fetchBlob(): Promise<PlacesBlob | null> {
  const url = import.meta.env.PLACES_DATA_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.warn(`[google-places] worker returned ${res.status}`);
      return null;
    }
    const data = await res.json() as PlacesBlob;
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (err) {
    console.warn('[google-places] fetch failed:', err);
    return null;
  }
}

function ensureFetch(): Promise<PlacesBlob | null> {
  if (!_blobPromise) _blobPromise = fetchBlob();
  return _blobPromise;
}

export async function fetchGoogleHours(): Promise<GooglePlaceHours | null> {
  const blob = await ensureFetch();
  return blob?.hours ?? null;
}

export async function fetchGooglePlaceData(): Promise<GooglePlaceData | null> {
  const blob = await ensureFetch();
  if (!blob || blob.rating == null || blob.reviewCount == null) return null;
  return {
    rating: blob.rating,
    reviewCount: blob.reviewCount,
    reviews: blob.reviews ?? [],
  };
}
