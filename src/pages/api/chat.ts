import type { APIRoute } from 'astro';

export const prerender = false;

// ─── Product catalog cache (refreshes every 5 min per isolate) ───
let productCache: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const PRODUCTS_QUERY = `
  query ($cursor: String) {
    products(first: 250, after: $cursor, sortKey: BEST_SELLING) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          handle
          productType
          availableForSale
          priceRange { minVariantPrice { amount } }
          compareAtPriceRange { minVariantPrice { amount } }
        }
      }
    }
  }
`;

// Compact format to stay within model context window (24k tokens)
function formatProduct(node: any): string {
  const price = parseFloat(node.priceRange.minVariantPrice.amount).toFixed(0);
  const sold = !node.availableForSale ? ' SOLD OUT' : '';
  return `${node.title} $${price}${sold} /shop/${node.handle}`;
}

const MAX_CATALOG_PRODUCTS = 200;

async function getProductCatalog(runtimeEnv: Record<string, any>): Promise<string> {
  if (productCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return productCache;
  }

  const domain = runtimeEnv.PUBLIC_SHOPIFY_STORE_DOMAIN || 'sunnyandranney.myshopify.com';
  const token = runtimeEnv.PUBLIC_SHOPIFY_STOREFRONT_TOKEN || '';

  if (!token) return 'Product catalog unavailable.';

  try {
    const allProducts: string[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    // Paginate through products (capped to fit model context window)
    while (hasNextPage && allProducts.length < MAX_CATALOG_PRODUCTS) {
      const res: Response = await fetch(`https://${domain}/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
      });

      const json: any = await res.json();
      const data: any = json.data?.products;
      if (!data) break;

      for (const edge of data.edges) {
        allProducts.push(formatProduct(edge.node));
      }

      hasNextPage = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;
    }

    const catalog = allProducts.join('\n');
    productCache = catalog;
    cacheTimestamp = Date.now();
    return catalog;
  } catch (err) {
    console.error('Failed to fetch product catalog:', err);
    return 'Product catalog temporarily unavailable.';
  }
}

// ─── System prompt ───────────────────────────────────────────
function buildSystemPrompt(catalog: string): string {
  return `You are Staci, the AI shopping assistant for **Sunny & Ranney** — a home goods store in Roswell, GA where 100% of profits go to **Sunshine on a Ranney Day**, a charity that provides home makeovers for children with special needs.

## Store Details
- **What we sell:** Furniture, home decor, lighting, gifts, kitchenware, and accessories. New inventory arrives regularly.
- **Pickup:** LOCAL PICKUP ONLY — we do not ship. All orders are picked up from our Roswell showroom.
- **Location:** Roswell, GA (customers can find directions on our website)
- **Hours:** Tuesday–Saturday, 10am–6pm. Closed Sunday & Monday.
- **Contact:** Customers can reach us through the website or visit in person.
- **Returns:** We accept returns within 14 days with original receipt. Items must be in original condition. No returns on sale items.
- **Payment:** We accept all major credit cards and cash.

## Mission
Sunny & Ranney exists to fund Sunshine on a Ranney Day (SOARD). Every single dollar of profit goes directly to providing bedroom makeovers, furniture, and home essentials for children with special needs and their families. When a customer buys from us, they are directly changing a child's life.

## Product Catalog (name, price, link)
${catalog}

## Rules
- Warm, concise (2-4 sentences). Use **bold** for key info.
- Recommend products as [Name](/shop/handle) with price.
- If SOLD OUT, say so and suggest alternatives.
- If not in catalog, say inventory changes often — visit in person or browse /shop.
- Never invent products. Occasionally mention the mission.`;
}

// ─── API handler ─────────────────────────────────────────────
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Messages array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runtime = (locals as any).runtime;
    const ai = runtime?.env?.AI;

    if (!ai) {
      return new Response(
        JSON.stringify({ error: 'AI binding not available.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch product catalog (cached)
    const catalog = await getProductCatalog(runtime.env);
    const systemMessage = { role: 'system', content: buildSystemPrompt(catalog) };

    const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [systemMessage, ...messages],
      max_tokens: 400,
    });

    return new Response(JSON.stringify({ reply: response.response }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Chat API error:', err?.message);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
