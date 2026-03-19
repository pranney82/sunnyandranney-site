import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { syncGoogleHoursToD1 } from '@/lib/sync-hours';

export const prerender = false;

const PRODUCTS_QUERY = `
  query ($cursor: String) {
    products(first: 250, after: $cursor, sortKey: BEST_SELLING) {
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
`;

/** Text used to generate the embedding — rich enough for semantic search */
function buildEmbeddingText(node: any): string {
  return [
    node.title,
    node.productType,
    node.description?.slice(0, 200),
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
    // 1. Fetch all products from Shopify
    const allProducts: any[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const res = await fetch(`https://${domain}/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
      });

      const json: any = await res.json();
      const data = json.data?.products;
      if (!data) break;

      for (const edge of data.edges) {
        allProducts.push(edge.node);
      }

      hasNextPage = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;
    }

    if (!allProducts.length) {
      return new Response(JSON.stringify({ error: 'No products found in Shopify.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
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
          availableForSale: node.availableForSale,
          price: node.priceRange.minVariantPrice.amount,
          compareAtPrice: node.compareAtPriceRange?.minVariantPrice?.amount || '0',
          imageUrl: node.images?.edges?.[0]?.node?.url || '',
        },
      }));

      await vectorize.upsert(vectors);
      indexed += vectors.length;
    }

    // Sync Google hours → D1 so Staci always has current hours
    const googleApiKey = env.GOOGLE_PLACES_API_KEY;
    const googlePlaceId = env.GOOGLE_PLACE_ID;
    let hoursSynced = false;
    if (googleApiKey && googlePlaceId) {
      hoursSynced = await syncGoogleHoursToD1(env.DB, googleApiKey, googlePlaceId);
    }

    // Trigger CF Pages rebuild with 10-minute debounce
    let rebuilt = false;
    const deployHookUrl = env.CF_DEPLOY_HOOK_URL;
    const DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes

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
      JSON.stringify({ success: true, indexed, total: allProducts.length, rebuilt, hoursSynced }),
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
