/**
 * Cloudflare Worker for the Sunny & Ranney loyalty system.
 * Handles Shopify webhooks (orders/paid, refunds/create) and serves balance lookups.
 */

import type { Env } from './env';
import { verifyShopifyHmac } from './lib/hmac';
import { alreadyProcessed, recordProcessed } from './lib/dedup';
import { handleOrdersPaid } from './handlers/ordersPaid';
import { handleRefundsCreate } from './handlers/refundsCreate';
import { handleBalance } from './handlers/balance';
import { handleInstall, handleCallback } from './handlers/oauth';
import { handleCreateRedemptionDiscount } from './handlers/createDiscount';
import { handleListRewards, handleGetReward, handleSeedRewards } from './handlers/rewards';
import { handleListTransactions } from './handlers/transactions';

async function handleWebhook(
  env: Env,
  request: Request,
  topic: 'orders/paid' | 'refunds/create',
): Promise<Response> {
  const signature = request.headers.get('X-Shopify-Hmac-Sha256');
  const webhookId = request.headers.get('X-Shopify-Webhook-Id');
  const shopDomain = request.headers.get('X-Shopify-Shop-Domain') ?? '';

  if (!webhookId) return new Response('missing webhook id', { status: 400 });

  // Read raw body BEFORE parsing — HMAC is computed over the raw bytes.
  const rawBody = await request.text();

  const valid = await verifyShopifyHmac(rawBody, signature, env.SHOPIFY_WEBHOOK_SECRET);
  if (!valid) return new Response('invalid hmac', { status: 401 });

  if (await alreadyProcessed(env.DB, webhookId)) {
    return new Response('already processed', { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  try {
    if (topic === 'orders/paid') {
      await handleOrdersPaid(env, payload as Parameters<typeof handleOrdersPaid>[1]);
    } else {
      await handleRefundsCreate(env, payload as Parameters<typeof handleRefundsCreate>[1]);
    }
    await recordProcessed(env.DB, webhookId, topic, shopDomain);
    return new Response('ok', { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error(`[loyalty] ${topic} failed for webhook ${webhookId}: ${msg}`);
    await recordProcessed(env.DB, webhookId, topic, shopDomain, 'failed', msg);
    // Return 500 so Shopify retries — but the dedup table has the failure logged for debug.
    return new Response(`processing error: ${msg}`, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/auth/install') {
      return handleInstall(env, url);
    }

    if (request.method === 'GET' && url.pathname === '/auth/callback') {
      return handleCallback(env, url);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/orders-paid') {
      return handleWebhook(env, request, 'orders/paid');
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/refunds-create') {
      return handleWebhook(env, request, 'refunds/create');
    }

    if (request.method === 'POST' && url.pathname === '/admin/create-redemption-discount') {
      return handleCreateRedemptionDiscount(env);
    }

    if (request.method === 'POST' && url.pathname === '/admin/seed-rewards') {
      return handleSeedRewards(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/rewards') {
      return handleListRewards(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/reward') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('id required', { status: 400 });
      return handleGetReward(env, id);
    }

    if (request.method === 'GET' && url.pathname === '/api/customer/balance') {
      const customerId = url.searchParams.get('customer_id');
      if (!customerId) return new Response('customer_id required', { status: 400 });
      return handleBalance(env, customerId);
    }

    if (request.method === 'GET' && url.pathname === '/api/customer/transactions') {
      const customerId = url.searchParams.get('customer_id');
      if (!customerId) return new Response('customer_id required', { status: 400 });
      const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
      return handleListTransactions(env, customerId, isNaN(limit) ? 10 : limit);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
