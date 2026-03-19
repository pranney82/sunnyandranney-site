import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { syncGoogleHoursToD1 } from '@/lib/sync-hours';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

const UPSERT_SQL = "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";

/**
 * POST /api/sync-settings
 *
 * Syncs live store hours from Google Places API + committed JSON settings
 * (specials, contact, email-signup) into D1 so runtime APIs (chat, subscribe)
 * have current config without waiting for a rebuild.
 *
 * Settings are read from the static /_settings/*.json endpoints that Astro
 * generates at build time from src/content/settings/.
 */
export const POST: APIRoute = async ({ request }) => {
  const syncSecret = env.SYNC_SECRET;
  if (!syncSecret) {
    return new Response(JSON.stringify({ error: 'Sync not configured.' }), {
      status: 403,
      headers: JSON_HEADERS,
    });
  }

  const provided = request.headers.get('x-sync-secret');
  if (provided !== syncSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }

  const db = env.DB;
  const synced: string[] = [];
  const origin = new URL(request.url).origin;

  // 1. Sync Google hours → D1
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  const placeId = env.GOOGLE_PLACE_ID;
  if (apiKey && placeId) {
    const hoursSynced = await syncGoogleHoursToD1(db, apiKey, placeId);
    if (hoursSynced) synced.push('hours');
  }

  // 2. Sync committed JSON settings → D1
  for (const name of ['specials', 'contact', 'email-signup'] as const) {
    try {
      const res = await fetch(`${origin}/_settings/${name}.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        await db.prepare(UPSERT_SQL).bind(`settings:${name}`, JSON.stringify(data)).run();
        synced.push(name);
      }
    } catch {
      console.warn(`[sync-settings] Failed to fetch ${name}.json`);
    }
  }

  return new Response(
    JSON.stringify({ success: synced.length > 0, synced }),
    { headers: JSON_HEADERS },
  );
};
