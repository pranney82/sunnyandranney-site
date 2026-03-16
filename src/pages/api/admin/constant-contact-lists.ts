import type { APIRoute } from 'astro';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const POST: APIRoute = async ({ request }) => {
  const { apiKey } = await request.json() as { apiKey: string };

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key is required' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  try {
    const res = await fetch('https://api.cc.email/v3/contact_lists', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return new Response(JSON.stringify({ error: `Constant Contact API error (${res.status}): ${text}` }), {
        status: res.status,
        headers: JSON_HEADERS,
      });
    }

    const data = await res.json() as { lists: Array<{ list_id: string; name: string; membership_count: number }> };

    return new Response(JSON.stringify({ lists: data.lists }), {
      headers: JSON_HEADERS,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to connect to Constant Contact' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
};
