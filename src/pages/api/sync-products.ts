import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { syncGoogleHoursToD1 } from '@/lib/sync-hours';
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

/** Text used to generate the embedding — rich enough for semantic search */
function buildEmbeddingText(node: any): string {
  return [
    node.title,
    node.productType,
    node.description?.slice(0, 500),
    ...(node.tags || []),
  ].filter(Boolean).join('. ');
}

export const POST: APIRoute = async ({ request }) => {
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
  const manualSecret = request.headers.get('x-sync-secret');

  if (shopifyHmac) {
    // Verify Shopify webhook HMAC-SHA256 signature
    const body = await request.clone().text();
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
  } else if (manualSecret !== syncSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const domain = env.PUBLIC_SHOPIFY_STORE_DOMAIN || 'sunnyandranney.myshopify.com';
  const token = env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN || '';

  if (!token) {
    return new Response(JSON.stringify({ error: 'Shopify token not configured.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
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

    if (!allProducts.length) {
      return new Response(JSON.stringify({ error: 'No products found in enabled collections.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1b. Track product availability for "Back in Stock" badges
    // Stores { handle: { available: boolean, backedAt?: ISO string } }
    // When a product goes from unavailable → available, we record the timestamp.
    // The front-end uses this timestamp to show a "Back in Stock" badge for 14 days.
    try {
      const prevStateRow = await env.DB.prepare(
        "SELECT value FROM settings WHERE key = 'settings:product_availability'"
      ).first<{ value: string }>();
      const prevState: Record<string, { available: boolean; backedAt?: string }> = prevStateRow
        ? JSON.parse(prevStateRow.value)
        : {};

      const currentState: Record<string, { available: boolean; backedAt?: string }> = {};

      for (const node of allProducts) {
        const prev = prevState[node.handle];
        const entry: { available: boolean; backedAt?: string } = {
          available: node.availableForSale,
        };

        if (prev && !prev.available && node.availableForSale) {
          // Was out of stock, now back — record the timestamp
          entry.backedAt = new Date().toISOString();
        } else if (prev?.backedAt) {
          // Carry forward existing backedAt timestamp
          entry.backedAt = prev.backedAt;
        }

        currentState[node.handle] = entry;
      }

      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('settings:product_availability', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(JSON.stringify(currentState)).run();
    } catch (err) {
      console.error('Availability tracking error:', err);
    }

    // 2. Generate embeddings in batches (Workers AI supports batch input)
    const BATCH_SIZE = 100;
    let indexed = 0;

    for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
      const batch = allProducts.slice(i, i + BATCH_SIZE);
      const texts = batch.map(buildEmbeddingText);

      const embeddingResult = (await ai.run('@cf/baai/bge-base-en-v1.5', {
        text: texts,
      })) as { data: number[][] };

      if (!embeddingResult.data?.length) continue;

      // 3. Upsert vectors into Vectorize with product metadata
      const vectors = batch.map((node: any, j: number) => ({
        id: node.handle.slice(0, 64), // Vectorize max ID is 64 bytes
        values: embeddingResult.data[j],
        metadata: {
          title: node.title,
          handle: node.handle,
          productType: node.productType || '',
          description: node.description?.slice(0, 300) || '',
          tags: (node.tags || []).join(', '),
          availableForSale: node.availableForSale,
          price: node.priceRange.minVariantPrice.amount,
          compareAtPrice: node.compareAtPriceRange?.minVariantPrice?.amount || '0',
          imageUrl: node.images?.edges?.[0]?.node?.url || '',
        },
      }));

      await vectorize.upsert(vectors);
      indexed += vectors.length;
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

    // Persist the current valid handles so the next sync can diff against them
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('settings:valid_product_handles', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(JSON.stringify(currentIds)).run();

    // Sync Google hours → D1 so Staci always has current hours
    const googleApiKey = env.GOOGLE_PLACES_API_KEY;
    const googlePlaceId = env.GOOGLE_PLACE_ID;
    let hoursSynced = false;
    if (googleApiKey && googlePlaceId) {
      hoursSynced = await syncGoogleHoursToD1(env.DB, googleApiKey, googlePlaceId);
    }

    // Sync specials + contact → D1 so Staci knows about promos/announcements
    const settingsSynced: string[] = [];
    const origin = new URL(request.url).origin;
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

    // Record last sync time so the cron worker can trigger a deploy
    // if no more webhooks come (catches the "edit then stop" case).
    let rebuilt = false;
    const deployHookUrl = env.CF_DEPLOY_HOOK_URL;
    const DEBOUNCE_MS = 30 * 60 * 1000; // 30 minutes

    try {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('last_sync', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(String(Date.now())).run();
    } catch {}

    if (deployHookUrl) {
      try {
        const lastRow = await env.DB.prepare(
          "SELECT value FROM settings WHERE key = 'last_rebuild'"
        ).first<{ value: string }>();

        const lastRebuild = lastRow ? Number(lastRow.value) : 0;

        if (Date.now() - lastRebuild > DEBOUNCE_MS) {
          const hookRes = await fetch(deployHookUrl, { method: 'POST' });
          rebuilt = hookRes.ok;

          if (hookRes.ok) {
            await env.DB.prepare(
              "INSERT INTO settings (key, value, updated_at) VALUES ('last_rebuild', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
            ).bind(String(Date.now())).run();
          } else {
            console.error('Deploy hook failed:', hookRes.status);
          }
        }
      } catch (err) {
        console.error('Deploy hook error:', err);
      }
    }

    return new Response(
      JSON.stringify({ success: true, indexed, total: allProducts.length, rebuilt, hoursSynced, settingsSynced }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Product sync error:', err?.message);
    return new Response(JSON.stringify({ error: 'Sync failed.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
