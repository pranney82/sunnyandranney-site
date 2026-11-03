import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

const UPSERT_SQL = "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";

/**
 * POST /api/sync-settings
 *
 * Syncs live store hours from Google Places API + committed JSON settings
 * (specials, contact) into D1 so runtime APIs (chat)
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

  // Hours + reviews are synced by the hours-sync worker on a daily cron;
  // this endpoint only refreshes the committed JSON settings.
  for (const name of ['specials', 'contact'] as const) {
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
