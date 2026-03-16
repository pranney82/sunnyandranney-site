import type { APIRoute } from 'astro';
import { getSetting, checkRateLimit } from '@/lib/db';
import type { EmailSignupConfig } from '@/lib/settings';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Rate limit: 5 signups per IP per hour
  const allowed = await checkRateLimit(`subscribe:${clientAddress}`, 5, 3600);
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: JSON_HEADERS,
    });
  }

  const { email } = await request.json() as { email: string };

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'Valid email address is required' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const config = await getSetting<EmailSignupConfig>('settings:email-signup');

  if (!config?.constantContactApiKey || !config?.constantContactListId) {
    return new Response(JSON.stringify({ error: 'Email signup is not configured yet' }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }

  try {
    const res = await fetch('https://api.cc.email/v3/contacts/sign_up_form', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.constantContactApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email_address: email,
        list_memberships: [config.constantContactListId],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Constant Contact API error:', res.status, text);
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
