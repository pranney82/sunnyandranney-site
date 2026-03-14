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

function formatProduct(node: any): string {
  const price = parseFloat(node.priceRange.minVariantPrice.amount).toFixed(2);
  const compareAt = parseFloat(node.compareAtPriceRange?.minVariantPrice?.amount || '0');
  const onSale = compareAt > parseFloat(price);

  return [
    `- **${node.title}**`,
    `$${price}${onSale ? ` (was $${compareAt.toFixed(2)})` : ''}`,
    node.productType ? `Category: ${node.productType}` : '',
    !node.availableForSale ? 'SOLD OUT' : '',
    `Link: /shop/${node.handle}`,
  ].filter(Boolean).join(' | ');
}

async function getProductCatalog(): Promise<string> {
  if (productCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return productCache;
  }

  const domain = import.meta.env.PUBLIC_SHOPIFY_STORE_DOMAIN || 'sunnyandranney.myshopify.com';
  const token = import.meta.env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN || '';

  if (!token) return 'Product catalog unavailable.';

  try {
    const allProducts: string[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    // Paginate through all products (250 per page, Shopify max)
    while (hasNextPage) {
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

## Current Product Catalog
Here are the products currently in the shop. Use this to answer product questions. When recommending products, include the link so customers can view them.

${catalog}

## Your Personality & Rules
- Warm, friendly, and concise — like a knowledgeable friend working at the shop
- Keep responses SHORT (2-4 sentences max unless the customer asks for detail)
- Use **bold** for emphasis on key info
- When recommending products, mention the name, price, and include the link formatted as [Product Name](/shop/handle)
- If a product is marked SOLD OUT, let the customer know and suggest similar items
- If asked about something not in the catalog, say inventory changes often and suggest they visit in person or browse the shop
- Never make up products that aren't in the catalog above
- Occasionally mention the mission — customers love knowing their purchase matters
- If a customer seems to be browsing, proactively suggest 2-3 relevant items from the catalog`;
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
        JSON.stringify({ error: 'AI binding not available. Make sure AI is enabled in wrangler.toml.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch product catalog (cached)
    const catalog = await getProductCatalog();
    const systemMessage = { role: 'system', content: buildSystemPrompt(catalog) };

    const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [systemMessage, ...messages],
      max_tokens: 400,
    });

    return new Response(JSON.stringify({ reply: response.response }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Chat API error:', err);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
