import type { APIRoute } from 'astro';

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

export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = (locals as any).runtime;
  const ai = runtime?.env?.AI;
  const vectorize = runtime?.env?.VECTORIZE;
  const env = runtime?.env;

  if (!ai || !vectorize) {
    return new Response(JSON.stringify({ error: 'AI or Vectorize binding not available.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Auth: accept either Shopify HMAC signature or manual x-sync-secret header
  const syncSecret = env.SYNC_SECRET || '';
  if (syncSecret) {
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

      const embeddingResult = await ai.run('@cf/baai/bge-base-en-v1.5', {
        text: texts,
      });

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
        },
      }));

      await vectorize.upsert(vectors);
      indexed += vectors.length;
    }

    return new Response(
      JSON.stringify({ success: true, indexed, total: allProducts.length }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Product sync error:', err?.message);
    return new Response(JSON.stringify({ error: 'Sync failed.', debug: err?.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
