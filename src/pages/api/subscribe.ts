import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { checkRateLimit } from '@/lib/db';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const KIT_API = 'https://api.kit.com/v4';
// The store's audience in Kit: store broadcasts go to this tag.
const KIT_TAG = 'Sunny & Ranney';

/** One Kit v4 call. KIT_API_KEY is a secret set in the Cloudflare dashboard. */
function kit(path: string, body: unknown) {
  return fetch(`${KIT_API}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'X-Kit-Api-Key': env.KIT_API_KEY!,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Rate limit: 5 signups per IP per hour
  const allowed = await checkRateLimit(`subscribe:${clientAddress}`, 5, 3600);
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: JSON_HEADERS,
    });
  }

  const { email, website } = await request.json().catch(() => ({})) as { email?: string; website?: string };

  // Honeypot: people never see the hidden "website" box, bots fill it in.
  // Answer like a real signup so the bot moves on, and add no one.
  if (website) {
    return new Response(JSON.stringify({ success: true }), { headers: JSON_HEADERS });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'Valid email address is required' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  if (!env.KIT_API_KEY) {
    return new Response(JSON.stringify({ error: 'Email signup is not configured yet' }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }

  try {
    // Create the subscriber and look up the tag (both answer 200 when they
    // already exist), then tag them.
    const [created, tag] = await Promise.all([
      kit('/subscribers', { email_address: email, state: 'active' }),
      kit('/tags', { name: KIT_TAG }),
    ]);
    const failed = !created.ok ? created : !tag.ok ? tag : null;
    const tagId = failed ? null : ((await tag.json()) as { tag?: { id?: number } }).tag?.id;
    const tagged = failed ?? (tagId
      ? await kit(`/tags/${tagId}/subscribers`, { email_address: email })
      : new Response('Kit returned no tag id', { status: 502 }));

    if (!tagged.ok) {
      console.error('Kit API error:', tagged.status, await tagged.text());
      return new Response(JSON.stringify({ error: 'Failed to subscribe. Please try again.' }), {
        status: 502,
        headers: JSON_HEADERS,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: JSON_HEADERS,
    });
  } catch (err: any) {
    console.error('Subscribe error:', err);
    return new Response(JSON.stringify({ error: 'Failed to subscribe. Please try again.' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
};
