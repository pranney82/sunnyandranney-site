import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { batchSetProductAvailability, pruneStaleAvailability, batchSetInventoryItemMap, pruneStaleInventoryMap } from '@/lib/db';
import { ensureProductRedirect } from '@/lib/shopify-redirects';
import { viaGateway, aiCapped } from '@/lib/ai';
import collectionsConfig from '@/content/settings/collections.json';

export const prerender = false;

const COLLECTION_PRODUCTS_QUERY = `
  query ($handle: String!, $cursor: String) {
    collection(handle: $handle) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            description
            productType
            tags
            availableForSale
            priceRange { minVariantPrice { amount } }
            compareAtPriceRange { minVariantPrice { amount } }
            images(first: 1) { edges { node { url } } }
          }
        }
      }
    }
  }
`;

// Admin API query to get inventory item IDs for products
const ADMIN_INVENTORY_QUERY = `
  query ($handles: String!, $cursor: String) {
    products(first: 50, query: $handles, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          handle
          variants(first: 10) {
            edges {
              node {
                inventoryItem { id }
              }
            }
          }
        }
      }
    }
  }
`;

/** Fetch inventory_item_id → handle mappings via Admin API */
async function fetchInventoryItemMap(
  domain: string,
  adminToken: string,
  handles: string[]
): Promise<Array<{ inventoryItemId: string; handle: string }>> {
  const results: Array<{ inventoryItemId: string; handle: string }> = [];
  if (!handles.length) return results;

  // Process in batches of 20 handles (Admin API query limit)
  const BATCH_SIZE = 20;
  for (let i = 0; i < handles.length; i += BATCH_SIZE) {
    const batch = handles.slice(i, i + BATCH_SIZE);
    const handleQuery = batch.map(h => `handle:${h}`).join(' OR ');

    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const res = await fetch(`https://${domain}/admin/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': adminToken,
        },
        body: JSON.stringify({
          query: ADMIN_INVENTORY_QUERY,
          variables: { handles: handleQuery, cursor },
        }),
      });

      if (!res.ok) break;

      const json: any = await res.json();
      const data = json.data?.products;
      if (!data) break;

      for (const edge of data.edges) {
        const product = edge.node;
        for (const variantEdge of product.variants?.edges || []) {
          const inventoryItemGid = variantEdge.node?.inventoryItem?.id;
          if (inventoryItemGid) {
            // Extract numeric ID from GID (gid://shopify/InventoryItem/12345)
            const match = inventoryItemGid.match(/\/(\d+)$/);
            if (match) {
              results.push({
                inventoryItemId: match[1],
                handle: product.handle,
              });
            }
          }
        }
      }

      hasNextPage = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;
    }
  }

  return results;
}

// Publication GIDs to auto-publish new products to (Headless, POS, Google & YouTube).
// Online Store is intentionally excluded — sunnyandranney.com is the public storefront,
// shop.sunnyandranney.com is being phased out via /products/{handle} redirects.
const AUTOPUBLISH_PUBLICATIONS = [
  'gid://shopify/Publication/284019392796', // Sunny & Ranney Headless
  'gid://shopify/Publication/270874607900', // Point of Sale
  'gid://shopify/Publication/280934121756', // Google & YouTube
];

/** Exchange client credentials for a 24h Admin API access token. */
async function getAdminAccessToken(domain: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

/** Publish a product to the configured sales channels via Admin GraphQL. */
async function publishProductToChannels(
  domain: string,
  adminToken: string,
  productGid: string,
): Promise<{ errors: string[] }> {
  const mutation = `
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }
  `;
  const res = await fetch(`https://${domain}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        id: productGid,
        input: AUTOPUBLISH_PUBLICATIONS.map(publicationId => ({ publicationId })),
      },
    }),
  });
  if (!res.ok) return { errors: [`HTTP ${res.status}`] };
  const json: any = await res.json();
  const userErrors = json.data?.publishablePublish?.userErrors || [];
  // "already published" errors are benign — treat as success
  const fatal = userErrors.filter((e: any) => !/already/i.test(e.message || ''));
  return { errors: fatal.map((e: any) => `${e.field?.join('.')}: ${e.message}`) };
}

/** Text used to generate the embedding — rich enough for semantic search */
function buildEmbeddingText(node: any): string {
  return [
    node.title,
    node.productType,
    node.description?.slice(0, 500),
    ...(node.tags || []),
  ].filter(Boolean).join('. ');
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Normalize a Shopify REST webhook payload into the Storefront-API shape
 *  that buildEmbeddingText and the metadata builder expect. */
function normalizeWebhookProduct(p: any): any {
  const tagsArr = typeof p.tags === 'string'
    ? p.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
    : (Array.isArray(p.tags) ? p.tags : []);
  const variant = p.variants?.[0] || {};
  const imageUrl = p.image?.src || p.images?.[0]?.src || '';
  const available = p.status === 'active' && (p.variants || []).some(
    (v: any) => (v.inventory_quantity ?? 0) > 0 || v.inventory_policy === 'continue'
  );
  return {
    title: p.title || '',
    handle: p.handle || '',
    productType: p.product_type || '',
    description: stripHtml(p.body_html || ''),
    tags: tagsArr,
    availableForSale: available,
    priceRange: { minVariantPrice: { amount: variant.price || '0' } },
    compareAtPriceRange: { minVariantPrice: { amount: variant.compare_at_price || '0' } },
    images: { edges: imageUrl ? [{ node: { url: imageUrl } }] : [] },
  };
}

// ─── When a full sync runs ──────────────────────────────────────
// Shopify gives a webhook 5 seconds, then counts it failed and sends it again,
// up to 8 more times over 4 hours. A full sync takes longer than that, so a
// webhook must never run one and wait for it. On Nov 5 2026, 447 products
// deleted in Shopify admin each ran the sync 9 times: 22,000 AI calls, about $20.
//
// Instead a webhook notes that the catalog changed and answers at once. The next
// webhook to arrive once the gap below has passed runs one sync after answering.
const CHANGED_KEY = 'settings:catalog_changed';
const CLAIM_KEY = 'settings:full_sync_claim';
const HASHES_KEY = 'settings:product_sync_hashes';
const FULL_SYNC_GAP_MINUTES = 15;

const sqliteNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

async function markCatalogChanged(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '""', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`
  ).bind(CHANGED_KEY).run();
}

/** True for the one caller that may run a full sync now. */
async function claimFullSync(): Promise<boolean> {
  const { results } = await env.DB.prepare('SELECT key FROM settings WHERE key IN (?, ?)')
    .bind(CHANGED_KEY, CLAIM_KEY).all<{ key: string }>();
  const keys = new Set(results.map(r => r.key));
  if (keys.has(CLAIM_KEY) && !keys.has(CHANGED_KEY)) return false;
  if (!keys.has(CLAIM_KEY)) await markCatalogChanged(); // the first ever sync

  // One statement, so of many webhooks at once only one gets the claim.
  const claim = await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '""', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at
     WHERE settings.updated_at <= datetime('now', ?)`
  ).bind(CLAIM_KEY, `-${FULL_SYNC_GAP_MINUTES} minutes`).run();
  return Boolean(claim.meta.changes);
}

/** Vector metadata for a product from the Storefront API. */
function productMetadata(node: any, textHash: string) {
  return {
    title: node.title,
    handle: node.handle,
    productType: node.productType || '',
    description: node.description?.slice(0, 300) || '',
    tags: (node.tags || []).join(', '),
    availableForSale: node.availableForSale,
    price: node.priceRange.minVariantPrice.amount,
    compareAtPrice: node.compareAtPriceRange?.minVariantPrice?.amount || '0',
    imageUrl: node.images?.edges?.[0]?.node?.url || '',
    textHash,
  };
}

/** Constant-time string equality — avoids the timing side channel of `!==`. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < ab.length; i++) r |= ab[i] ^ bb[i];
  return r === 0;
}

/** The whole catalog: embeds what changed, clears what's gone, refreshes availability. */
async function runFullSync({ ai, vectorize, domain, token, origin, syncSecret }: {
  ai: any; vectorize: any; domain: string; token: string; origin: string; syncSecret: string;
}) {
  const startedAt = sqliteNow();

  // The migrations that made these two tables never ran on production, so the
  // chat's availability check found nothing and it had no real products to show.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS product_availability (
      handle TEXT PRIMARY KEY,
      available INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS inventory_item_map (
      inventory_item_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL
    )`),
  ]);

  // 1. Fetch products only from enabled collections on the site
  const enabledHandles = collectionsConfig
    .filter((c: any) => c.enabled)
    .map((c: any) => c.handle);

  const seenHandles = new Set<string>();
  const allProducts: any[] = [];

  for (const collectionHandle of enabledHandles) {
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const res = await fetch(`https://${domain}/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({
          query: COLLECTION_PRODUCTS_QUERY,
          variables: { handle: collectionHandle, cursor },
        }),
      });

      const json: any = await res.json();
      const data = json.data?.collection?.products;
      if (!data) break;

      for (const edge of data.edges) {
        const node = edge.node;
        // Deduplicate products that appear in multiple collections
        if (!seenHandles.has(node.handle)) {
          seenHandles.add(node.handle);
          allProducts.push(node);
        }
      }

      hasNextPage = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;
    }
  }

  if (!allProducts.length) throw new Error('No products found in enabled collections.');

  // 2. Embed only what changed since the last full sync. The hash covers the
  // metadata as well as the text, so a new price still reaches the vector.
  const hashRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(HASHES_KEY).first<{ value: string }>();
  const prevHashes: Record<string, string> = hashRow ? JSON.parse(hashRow.value) : {};

  const entries = await Promise.all(allProducts.map(async (node: any) => {
    const text = buildEmbeddingText(node);
    const metadata = productMetadata(node, await sha256Hex(text));
    return {
      id: node.handle.slice(0, 64), // Vectorize max ID is 64 bytes
      text,
      metadata,
      hash: await sha256Hex(JSON.stringify([text, metadata])),
    };
  }));

  const nextHashes: Record<string, string> = {};
  const changed = entries.filter(e => {
    if (prevHashes[e.id] !== e.hash) return true;
    nextHashes[e.id] = e.hash;
    return false;
  });

  const BATCH_SIZE = 100;
  let indexed = 0;
  // Kept after every batch: a sync cut off or stopped at a cap goes on from there, not from the start
  const saveHashes = () => env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(HASHES_KEY, JSON.stringify(nextHashes)).run();

  for (let i = 0; i < changed.length; i += BATCH_SIZE) {
    const batch = changed.slice(i, i + BATCH_SIZE);

    const embeddingResult = (await ai.run('@cf/baai/bge-base-en-v1.5', {
      text: batch.map(e => e.text),
    }, viaGateway('product-sync'))) as { data: number[][] };

    if (!embeddingResult.data?.length) continue;

    // 3. Upsert vectors into Vectorize with product metadata
    await vectorize.upsert(batch.map((e, j) => ({
      id: e.id,
      values: embeddingResult.data[j],
      metadata: e.metadata,
    })));
    for (const e of batch) nextHashes[e.id] = e.hash;
    indexed += batch.length;
    await saveHashes();
  }

  // 4. Remove stale vectors for products no longer in enabled collections.
  // Compare against the previous sync's handle list stored in D1 — this is
  // deterministic and doesn't rely on querying vectors (which was unreliable).
  const currentIds = Array.from(seenHandles).map(h => h.slice(0, 64));
  const currentIdSet = new Set(currentIds);

  try {
    const prevRow = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'settings:valid_product_handles'"
    ).first<{ value: string }>();
    const prevIds: string[] = prevRow ? JSON.parse(prevRow.value) : [];
    const staleIds = prevIds.filter(id => !currentIdSet.has(id));

    if (staleIds.length) {
      // Vectorize deleteByIds accepts max 1000 at a time
      for (let i = 0; i < staleIds.length; i += 1000) {
        await vectorize.deleteByIds(staleIds.slice(i, i + 1000));
      }
    }
  } catch {
    // Non-critical — stale vectors will just score low in searches
  }

  await saveHashes();

  // Persist the current valid handles so the next sync can diff against them
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('settings:valid_product_handles', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(JSON.stringify(currentIds)).run();

  // Persist availability to dedicated D1 table (webhooks update this incrementally)
  const availabilityData = allProducts.map(p => ({
    handle: p.handle,
    available: p.availableForSale,
  }));
  await batchSetProductAvailability(availabilityData);
  await pruneStaleAvailability(seenHandles);

  // Build inventory_item_id → handle mapping for inventory_levels/update webhooks
  // Requires Admin API to get inventory item IDs
  if (env.SHOPIFY_ADMIN_TOKEN) {
    try {
      const inventoryMap = await fetchInventoryItemMap(
        domain,
        env.SHOPIFY_ADMIN_TOKEN,
        Array.from(seenHandles)
      );
      if (inventoryMap.length) {
        await batchSetInventoryItemMap(inventoryMap);
        await pruneStaleInventoryMap(seenHandles);
      }
    } catch (err) {
      console.error('Inventory map sync error (non-critical):', err);
    }
  }

  // Sync specials + contact → D1 so Staci knows about promos/announcements
  const settingsSynced: string[] = [];
  for (const name of ['specials', 'contact'] as const) {
    try {
      const res = await fetch(`${origin}/_settings/${name}.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        await env.DB.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).bind(`settings:${name}`, JSON.stringify(data)).run();
        settingsSynced.push(name);
      }
    } catch {
      // Non-critical — settings will sync on next manual trigger
    }
  }

  // Poke the DeployCoordinator Durable Object to schedule a deploy.
  // The DO debounces: each poke resets a 15-minute alarm. A 30-minute
  // max-wait cap ensures deploys can't be deferred indefinitely.
  let rebuilt = false;
  try {
    const id = env.DEPLOY_COORDINATOR.idFromName('singleton');
    const stub = env.DEPLOY_COORDINATOR.get(id);
    const pokeRes = await stub.fetch(new Request('https://do/poke', {
      method: 'POST',
      headers: { 'X-Poke-Secret': syncSecret },
    }));
    rebuilt = pokeRes.ok;
  } catch (err) {
    console.error('Deploy coordinator error:', err);
  }

  // A change noted while this ran is left for the next sync.
  await env.DB.prepare('DELETE FROM settings WHERE key = ? AND updated_at < ?')
    .bind(CHANGED_KEY, startedAt).run();

  return { indexed, unchanged: entries.length - changed.length, total: allProducts.length, rebuilt, settingsSynced };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const ai = env.AI;
  const vectorize = env.VECTORIZE;

  if (!ai || !vectorize) {
    return new Response(JSON.stringify({ error: 'AI or Vectorize binding not available.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Auth: require SYNC_SECRET — accept either Shopify HMAC signature or manual header
  const syncSecret = env.SYNC_SECRET;
  if (!syncSecret) {
    return new Response(JSON.stringify({ error: 'Sync not configured.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const shopifyHmac = request.headers.get('x-shopify-hmac-sha256');
  const shopifyTopic = request.headers.get('x-shopify-topic');
  const manualSecret = request.headers.get('x-sync-secret');
  let rawBody: string | null = null;

  if (shopifyHmac) {
    // Verify Shopify webhook HMAC-SHA256 signature
    rawBody = await request.clone().text();
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(syncSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    // crypto.subtle.verify is constant-time; avoids the timing side channel of `===`.
    let valid = false;
    try {
      const sigBytes = Uint8Array.from(atob(shopifyHmac), (c) => c.charCodeAt(0));
      valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(rawBody));
    } catch {
      valid = false;
    }
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } else if (!manualSecret || !timingSafeEqualStr(manualSecret, syncSecret)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const domain = env.PUBLIC_SHOPIFY_STORE_DOMAIN || 'sunnyandranney.myshopify.com';
  const token = env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN || '';

  // Admin-API-dependent side effects (auto-publish, redirect ensure) share a
  // single token exchange. Non-fatal on failure — a miss gets caught on the
  // next products/update webhook or manual sync.
  let autoPublishResult: { productId?: string; errors: string[] } | null = null;
  let redirectResult: { handle?: string; action?: string; error?: string } | null = null;

  const needsAdminApi =
    (shopifyTopic === 'products/create' || shopifyTopic === 'products/update') &&
    rawBody &&
    env.SHOPIFY_CLIENT_ID &&
    env.SHOPIFY_CLIENT_SECRET;

  if (needsAdminApi) {
    let adminToken: string | null = null;
    let product: any = null;
    try {
      product = JSON.parse(rawBody!);
      adminToken = await getAdminAccessToken(domain, env.SHOPIFY_CLIENT_ID!, env.SHOPIFY_CLIENT_SECRET!);
    } catch (err: any) {
      console.error('Admin token exchange failed (non-critical):', err?.message);
    }

    // Auto-publish: only on products/create (existing behavior).
    if (adminToken && product && shopifyTopic === 'products/create') {
      try {
        const productGid = `gid://shopify/Product/${product.id}`;
        const { errors } = await publishProductToChannels(domain, adminToken, productGid);
        autoPublishResult = { productId: productGid, errors };
        if (errors.length) console.error('Auto-publish errors:', errors);
      } catch (err: any) {
        console.error('Auto-publish failed (non-critical):', err?.message);
        autoPublishResult = { errors: [err?.message || 'unknown'] };
      }
    }

    // Redirect ensure: on both create and update, so handle renames are kept in sync.
    if (adminToken && product?.handle) {
      const { action, error } = await ensureProductRedirect(domain, adminToken, product.handle);
      redirectResult = { handle: product.handle, action, error };
      if (error) console.error('Redirect ensure error:', error);
    }
  }

  const origin = new URL(request.url).origin;

  /** After answering Shopify, run one full sync if one is owed. Never fails a webhook. */
  const fullSyncIfDue = async () => {
    try {
      if (!token || !(await claimFullSync())) return;
      (locals as any).runtime.ctx.waitUntil(
        runFullSync({ ai, vectorize, domain, token, origin, syncSecret })
          .catch((err: any) => console.error('Product sync error:', err?.message))
      );
    } catch (err: any) {
      console.error('Full sync check failed:', err?.message);
    }
  };

  // ─── Fast path: single-product webhook ─────────────────────────
  // Avoids re-embedding the entire catalog on every Shopify product update.
  if (rawBody && (shopifyTopic === 'products/update' || shopifyTopic === 'products/create')) {
    try {
      const raw = JSON.parse(rawBody);
      const node = normalizeWebhookProduct(raw);
      if (!node.handle) throw new Error('webhook missing handle');

      const id = node.handle.slice(0, 64);
      const text = buildEmbeddingText(node);
      const nextHash = await sha256Hex(text);

      let prevHash: string | undefined;
      try {
        const existing = await vectorize.getByIds([id]);
        prevHash = existing?.[0]?.metadata?.textHash as string | undefined;
      } catch { /* no existing vector — treat as new */ }

      let embedded = false;
      if (text && prevHash !== nextHash) {
        // A cap reached: price and stock still go in below, and the next full sync reads the new words
        const embeddingResult = (await ai.run('@cf/baai/bge-base-en-v1.5', {
          text: [text],
        }, viaGateway('product-sync')).catch(async (err: unknown) => {
          if (!aiCapped(err)) throw err;
          await markCatalogChanged();
          return null;
        })) as { data: number[][] } | null;
        if (embeddingResult?.data?.[0]) {
          await vectorize.upsert([{
            id,
            values: embeddingResult.data[0],
            metadata: {
              title: node.title,
              handle: node.handle,
              productType: node.productType,
              description: node.description.slice(0, 300),
              tags: node.tags.join(', '),
              availableForSale: node.availableForSale,
              price: node.priceRange.minVariantPrice.amount,
              compareAtPrice: node.compareAtPriceRange.minVariantPrice.amount,
              imageUrl: node.images.edges[0]?.node.url || '',
              textHash: nextHash,
            },
          }]);
          embedded = true;
        }
      }

      await batchSetProductAvailability([{ handle: node.handle, available: node.availableForSale }]);

      try {
        const row = await env.DB.prepare(
          "SELECT value FROM settings WHERE key = 'settings:valid_product_handles'"
        ).first<{ value: string }>();
        const prev: string[] = row ? JSON.parse(row.value) : [];
        if (!prev.includes(id)) {
          prev.push(id);
          await env.DB.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES ('settings:valid_product_handles', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
          ).bind(JSON.stringify(prev)).run();
        }
      } catch { /* non-critical */ }

      let rebuilt = false;
      try {
        const doId = env.DEPLOY_COORDINATOR.idFromName('singleton');
        const stub = env.DEPLOY_COORDINATOR.get(doId);
        const pokeRes = await stub.fetch(new Request('https://do/poke', {
          method: 'POST',
          headers: { 'X-Poke-Secret': syncSecret },
        }));
        rebuilt = pokeRes.ok;
      } catch (err) {
        console.error('Deploy coordinator error (non-critical):', err);
      }

      await fullSyncIfDue();

      return new Response(
        JSON.stringify({
          success: true,
          path: 'single-product',
          handle: node.handle,
          embedded,
          rebuilt,
          autoPublish: autoPublishResult,
          redirect: redirectResult,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err: any) {
      // Shopify sends this one product again. It never widens into a full sync.
      console.error('Single-product sync failed:', err?.message);
      return new Response(JSON.stringify({ error: 'Sync failed.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Any other webhook, products/delete above all: it carries only a number, never
  // the handle a vector is stored under, so the next full sync clears it out.
  if (shopifyHmac) {
    await markCatalogChanged();
    await fullSyncIfDue();
    return new Response(JSON.stringify({ success: true, path: 'noted', topic: shopifyTopic }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!token) {
    return new Response(JSON.stringify({ error: 'Shopify token not configured.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await runFullSync({ ai, vectorize, domain, token, origin, syncSecret });
    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Product sync error:', err?.message);
    return new Response(JSON.stringify({ error: 'Sync failed.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
