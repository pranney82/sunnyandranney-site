import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { setProductAvailability, getHandleByInventoryItemId } from '@/lib/db';

export const prerender = false;

/**
 * Shopify Webhook Handler for inventory/product updates.
 * Updates D1 availability table so Staci never recommends sold-out items.
 *
 * Subscribe these Shopify webhooks (Settings → Notifications → Webhooks):
 * - products/update → https://sunnyandranney.com/api/webhook/inventory
 * - products/create → https://sunnyandranney.com/api/webhook/inventory
 */
export const POST: APIRoute = async ({ request }) => {
  const syncSecret = env.SYNC_SECRET;
  if (!syncSecret) {
    return new Response(JSON.stringify({ error: 'Not configured' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify Shopify HMAC signature
  const shopifyHmac = request.headers.get('x-shopify-hmac-sha256');
  if (!shopifyHmac) {
    return new Response(JSON.stringify({ error: 'Missing signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.text();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(syncSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));

  if (computed !== shopifyHmac) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const payload = JSON.parse(body);
    const topic = request.headers.get('x-shopify-topic') || '';

    if (topic === 'products/update' || topic === 'products/create') {
      const handle = payload.handle;
      // Available if product is active AND has inventory (or sells when out of stock)
      const available = payload.status === 'active' &&
        payload.variants?.some((v: any) => v.inventory_quantity > 0 || v.inventory_policy === 'continue');

      if (handle) {
        await setProductAvailability(handle, available);
        return new Response(JSON.stringify({ success: true, handle, available }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (topic === 'inventory_levels/update') {
      // Inventory level changed - look up product handle from mapping table
      const inventoryItemId = String(payload.inventory_item_id);
      const available = (payload.available ?? 0) > 0;

      const handle = await getHandleByInventoryItemId(inventoryItemId);
      if (handle) {
        await setProductAvailability(handle, available);
        return new Response(JSON.stringify({ success: true, handle, available, source: 'inventory_levels' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Mapping not found - will be populated on next full sync
      return new Response(JSON.stringify({ success: true, skipped: true, reason: 'unmapped_inventory_item' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, skipped: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Webhook error:', err?.message);
    return new Response(JSON.stringify({ error: 'Processing failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
