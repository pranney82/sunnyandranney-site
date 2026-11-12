import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebhook, sendTemplate, signWebhook, verifyWebhook } from './sent-dm.mjs';

const SECRET = `whsec_${btoa('a-test-secret-of-32-bytes-long!!')}`;

test('a webhook signed with the secret passes, anything else fails', async () => {
  const now = 1_800_000_000;
  const body = '{"field":"message","event":"message.delivered"}';
  const signature = await signWebhook({ id: 'msg_1', timestamp: String(now), body, secret: SECRET });
  const base = { id: 'msg_1', timestamp: String(now), signature, body, secret: SECRET, nowSeconds: now };

  assert.equal(await verifyWebhook(base), true);
  // Several signatures, one of them right (secret rotation).
  assert.equal(await verifyWebhook({ ...base, signature: `v1,bm9wZQ== ${signature}` }), true);
  assert.equal(await verifyWebhook({ ...base, body: body.replace('delivered', 'failed') }), false);
  assert.equal(await verifyWebhook({ ...base, id: 'msg_2' }), false);
  assert.equal(await verifyWebhook({ ...base, secret: `whsec_${btoa('another-secret')}` }), false);
  assert.equal(await verifyWebhook({ ...base, signature: signature.replace('v1,', 'v2,') }), false);
  assert.equal(await verifyWebhook({ ...base, signature: 'v1,not base64!' }), false);
  assert.equal(await verifyWebhook({ ...base, signature: '' }), false);
  // Older or newer than five minutes is a replay.
  assert.equal(await verifyWebhook({ ...base, nowSeconds: now + 301 }), false);
  assert.equal(await verifyWebhook({ ...base, nowSeconds: now - 301 }), false);
  assert.equal(await verifyWebhook({ ...base, nowSeconds: now + 299 }), true);
});

function fakeFetch(status, body, seen = []) {
  return async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

test('a send asks for SMS only, by template id, with the idempotency key', async () => {
  const seen = [];
  const result = await sendTemplate({
    apiKey: 'key-1',
    to: '+16785551234',
    templateId: 'tpl',
    parameters: { week: 'week of Nov 15', shifts: 'Mon 10a-5p' },
    idempotencyKey: 'row-1',
    fetchImpl: fakeFetch(202, {
      success: true,
      data: { status: 'QUEUED', recipients: [{ message_id: 'm-1', to: '+16785551234', channel: 'sms', body: 'hi' }] },
    }, seen),
  });
  assert.deepEqual(result, { ok: true, messageId: 'm-1', status: 'QUEUED', body: 'hi' });
  assert.equal(seen[0].url, 'https://api.sent.dm/v3/messages');
  assert.equal(seen[0].init.headers['x-api-key'], 'key-1');
  assert.equal(seen[0].init.headers['Idempotency-Key'], 'row-1');
  assert.deepEqual(seen[0].body, {
    to: ['+16785551234'],
    channel: ['sms'],
    template: { id: 'tpl', parameters: { week: 'week of Nov 15', shifts: 'Mon 10a-5p' } },
  });
});

test('a refused send says why', async () => {
  const result = await sendTemplate({
    apiKey: 'k',
    to: '+16785551234',
    templateId: 'tpl',
    idempotencyKey: 'row-2',
    fetchImpl: fakeFetch(400, { success: false, error: { code: 'VALIDATION_004', message: 'Invalid parameters' } }),
  });
  assert.deepEqual(result, { ok: false, status: 400, code: 'VALIDATION_004', message: 'Invalid parameters' });

  const offline = await sendTemplate({
    apiKey: 'k',
    to: '+16785551234',
    templateId: 'tpl',
    idempotencyKey: 'row-3',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.code, 'NETWORK');
});

test('creating the webhook returns its signing secret', async () => {
  const seen = [];
  const result = await createWebhook({
    apiKey: 'k',
    endpointUrl: 'https://sunnyandranney.com/api/webhook/sent-dm',
    fetchImpl: fakeFetch(201, { success: true, data: { id: 'wh-1', signing_secret: 'whsec_abc' } }, seen),
  });
  assert.deepEqual(result, { ok: true, id: 'wh-1', secret: 'whsec_abc' });
  assert.deepEqual(seen[0].body.event_types, ['message', 'contact']);
  assert.equal(seen[0].body.endpoint_url, 'https://sunnyandranney.com/api/webhook/sent-dm');
});
