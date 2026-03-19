import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { syncGoogleHoursToD1 } from '@/lib/sync-hours';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * POST /api/sync-settings
 *
 * Fetches live store hours from Google Places API and writes them to D1.
 * Also runs automatically as part of sync-products, but this endpoint
 * allows manual triggering when only hours need updating.
 */
export const POST: APIRoute = async ({ request }) => {
  const syncSecret = (env as any).SYNC_SECRET || '';
  if (syncSecret) {
    const provided = request.headers.get('x-sync-secret');
    if (provided !== syncSecret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }
  }

  const apiKey = (env as any).GOOGLE_PLACES_API_KEY;
  const placeId = (env as any).GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    return new Response(JSON.stringify({ error: 'GOOGLE_PLACES_API_KEY and GOOGLE_PLACE_ID required' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }

  const hoursSynced = await syncGoogleHoursToD1(env.DB, apiKey, placeId);

  return new Response(
    JSON.stringify({ success: hoursSynced, synced: hoursSynced ? ['hours'] : [] }),
    { headers: JSON_HEADERS },
  );
};
