/**
 * sent.dm, the store's SMS provider: sending a template, creating the webhook
 * and checking a webhook's signature. Plain JS so tests can run it with a
 * stand-in fetch.
 *
 * Docs: https://docs.sent.dm/reference/api/messages/SentDmServicesEndpointsCustomerAPIv3MessagesSendMessageV3Endpoint.md
 * and https://docs.sent.dm/build/signature-verification.md
 */

export const SENT_DM_API = 'https://api.sent.dm/v3';

const TIMEOUT_MS = 8000;

/**
 * @typedef {{ ok: false, status: number, code: string, message: string }} Failure
 * @typedef {{ apiKey: string, base?: string, fetchImpl?: typeof fetch }} Connection
 */

/**
 * @param {Connection & { path: string, body: unknown, idempotencyKey?: string }} input
 * @returns {Promise<{ ok: true, status: number, data: any } | Failure>}
 */
async function call({ apiKey, base = SENT_DM_API, path, body, idempotencyKey, fetchImpl = fetch }) {
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: /** @type {const} */ (false), status: 0, code: 'NETWORK', message: err?.name === 'TimeoutError' ? 'sent.dm didn’t answer in time.' : 'Couldn’t reach sent.dm.' };
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (response.ok && parsed?.success !== false) return { ok: /** @type {const} */ (true), status: response.status, data: parsed?.data ?? null };
  return {
    ok: /** @type {const} */ (false),
    status: response.status,
    code: parsed?.error?.code ?? `HTTP_${response.status}`,
    message: parsed?.error?.message ?? `sent.dm answered ${response.status}.`,
  };
}

/**
 * Texts one number a template, by SMS only (never WhatsApp). sent.dm answers
 * 202 even when it later refuses to deliver (opted out, not approved); those
 * outcomes arrive by webhook.
 *
 * @param {Connection & { to: string, templateId: string, parameters?: Record<string, string>, idempotencyKey: string, sandbox?: boolean }} input
 * @returns {Promise<{ ok: true, messageId: string | null, status: string, body: string | null } | Failure>}
 */
export async function sendTemplate({ apiKey, base, to, templateId, parameters = {}, idempotencyKey, sandbox = false, fetchImpl }) {
  const result = await call({
    apiKey,
    base,
    path: '/messages',
    idempotencyKey,
    fetchImpl,
    body: { to: [to], channel: ['sms'], template: { id: templateId, parameters }, ...(sandbox ? { sandbox: true } : {}) },
  });
  if (!result.ok) return result;
  const recipient = result.data?.recipients?.find((r) => r.channel === 'sms') ?? result.data?.recipients?.[0];
  return { ok: /** @type {const} */ (true), messageId: recipient?.message_id ?? null, status: result.data?.status ?? 'QUEUED', body: recipient?.body ?? null };
}

/**
 * Creates the webhook that reports delivery and STOP replies. The signing secret is only ever shown here.
 * @param {Connection & { endpointUrl: string }} input
 * @returns {Promise<{ ok: true, id: string, secret: string } | Failure>}
 */
export async function createWebhook({ apiKey, base, endpointUrl, fetchImpl }) {
  const result = await call({
    apiKey,
    base,
    path: '/webhooks',
    fetchImpl,
    body: { display_name: 'Sunny & Ranney schedule texts', endpoint_url: endpointUrl, event_types: ['message', 'contact'] },
  });
  if (!result.ok) return result;
  const id = result.data?.id;
  const secret = result.data?.signing_secret;
  if (!id || typeof secret !== 'string' || !secret) return { ok: /** @type {const} */ (false), status: result.status, code: 'NO_SECRET', message: 'sent.dm didn’t return a signing secret.' };
  return { ok: /** @type {const} */ (true), id: String(id), secret };
}

// ─── Webhook signatures ──────────────────────────────────────

const TOLERANCE_SECONDS = 300;

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function secretBytes(secret) {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  try {
    return decodeBase64(raw);
  } catch {
    return new TextEncoder().encode(raw);
  }
}

/**
 * Checks a webhook the way sent.dm signs it: HMAC-SHA256 over
 * "{id}.{timestamp}.{raw body}" with the base64-decoded secret, sent as
 * "v1,<base64>" (space-separated if there are several), within five minutes.
 * crypto.subtle.verify compares in constant time.
 */
/**
 * @param {{ id: string | null, timestamp: string | null, signature: string | null, body: string, secret: string, nowSeconds?: number }} input
 */
export async function verifyWebhook({ id, timestamp, signature, body, secret, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!id || !timestamp || !signature || !secret || typeof body !== 'string') return false;
  let seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) seconds = Date.parse(timestamp) / 1000;
  else if (seconds > 1e12) seconds /= 1000;
  if (!Number.isFinite(seconds) || Math.abs(nowSeconds - seconds) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  for (const token of signature.trim().split(/\s+/)) {
    const comma = token.indexOf(',');
    if (comma < 0 || token.slice(0, comma) !== 'v1') continue;
    let given;
    try {
      given = decodeBase64(token.slice(comma + 1));
    } catch {
      continue;
    }
    if (await crypto.subtle.verify('HMAC', key, given, data)) return true;
  }
  return false;
}

/**
 * Signs like sent.dm does. For tests and the local stand-in only.
 * @param {{ id: string, timestamp: string, body: string, secret: string }} input
 */
export async function signWebhook({ id, timestamp, body, secret }) {
  const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}
