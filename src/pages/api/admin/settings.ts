import type { APIRoute } from 'astro';
import { getSetting, getAllSettings, saveSetting } from '@/lib/db';

export const prerender = false;

const VALID_KEYS = ['settings:hours', 'settings:collections', 'settings:specials', 'settings:contact', 'settings:email-signup', 'settings:trending', 'settings:hero', 'settings:kids'];
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const GET: APIRoute = async ({ url }) => {
  const key = url.searchParams.get('key');

  if (key) {
    if (!VALID_KEYS.includes(key)) {
      return new Response(JSON.stringify({ error: 'Invalid key' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const value = await getSetting(key);
    return new Response(JSON.stringify({ key, value }), {
      headers: JSON_HEADERS,
    });
  }

  const results = await getAllSettings();
  return new Response(JSON.stringify(results), {
    headers: JSON_HEADERS,
  });
};

export const PUT: APIRoute = async ({ request }) => {
  const body = await request.json() as { key: string; value: unknown };
  const { key, value } = body;

  if (!key || !VALID_KEYS.includes(key)) {
    return new Response(JSON.stringify({ error: 'Invalid key' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const result = await saveSetting(key, value);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }

  return new Response(JSON.stringify({ success: true, key, warning: result.warning }), {
    headers: JSON_HEADERS,
  });
};
