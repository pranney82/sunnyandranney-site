import type { APIRoute } from 'astro';
import { getSetting } from '@/lib/db';

export const prerender = false;

/** How many days after restocking to show the "Back in Stock" badge */
const BADGE_WINDOW_DAYS = 30;

/**
 * Returns product handles that came back in stock within the last 14 days.
 * Used client-side by the shop grid to add "Back in Stock" badges.
 */
export const GET: APIRoute = async () => {
  const state = await getSetting<Record<string, { available: boolean; backedAt?: string }>>(
    'settings:product_availability'
  );

  if (!state) {
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  }

  const cutoff = Date.now() - BADGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const handles: string[] = [];

  for (const [handle, entry] of Object.entries(state)) {
    if (entry.backedAt && entry.available && new Date(entry.backedAt).getTime() > cutoff) {
      handles.push(handle);
    }
  }

  return new Response(JSON.stringify(handles), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};
