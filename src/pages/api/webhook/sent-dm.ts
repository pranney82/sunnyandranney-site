import type { APIRoute } from 'astro';
import { applyTextEvent, webhookSecret } from '@/lib/schedule/texting';
import { verifyWebhook } from '@/lib/sent-dm.mjs';

export const prerender = false;

/**
 * sent.dm reports here: whether each schedule text was delivered, and STOP or
 * START replies. Created by the admin (textsConnect), which keeps the signing
 * secret in D1. Public, so every request must carry a valid signature.
 */

const MAX_BODY = 64 * 1024;
/** An event for a text this hasn't recorded yet is retried for this long, in case it beat the send's own write. */
const RETRY_UNKNOWN_MS = 5 * 60 * 1000;

const reply = (status: number, body: Record<string, unknown> = { ok: status < 300 }) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const db = locals.runtime.env.DB;
  const secret = await webhookSecret(db);
  if (!secret) return reply(404, { error: 'Not set up' });

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) return reply(413, { error: 'Too large' });
  const body = await request.text();
  if (body.length > MAX_BODY) return reply(413, { error: 'Too large' });

  // Version 2 headers, falling back to version 1's.
  const header = (v2: string, v1: string) => request.headers.get(v2) ?? request.headers.get(v1);
  const valid = await verifyWebhook({
    id: header('webhook-id', 'x-webhook-id'),
    timestamp: header('webhook-timestamp', 'x-webhook-timestamp'),
    signature: header('webhook-signature', 'x-webhook-signature'),
    body,
    secret,
  });
  if (!valid) return reply(401, { error: 'Bad signature' });

  let event: Parameters<typeof applyTextEvent>[1];
  try {
    event = JSON.parse(body);
  } catch {
    return reply(400, { error: 'Not JSON' });
  }
  if (!event || typeof event !== 'object') return reply(400, { error: 'Not an event' });

  const outcome = await applyTextEvent(db, event);
  if (outcome === 'unknown-message') {
    const sent = Date.parse(event.timestamp ?? '');
    // Too new to have been recorded yet: ask sent.dm to send it again shortly.
    if (Number.isFinite(sent) && Date.now() - sent < RETRY_UNKNOWN_MS) return reply(503, { error: 'Not recorded yet' });
  }
  return reply(200, { ok: true, outcome });
};
