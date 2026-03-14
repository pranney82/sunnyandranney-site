import type { APIRoute } from 'astro';

export const prerender = false;

// ─── Types ───────────────────────────────────────────────────
interface Product {
  title: string;
  handle: string;
  productType: string;
  availableForSale: boolean;
  price: string;
  compareAtPrice: string;
}

// ─── System prompt (static — no catalog stuffed in) ──────────
const SYSTEM_PROMPT = `You are Staci, the AI shopping assistant for **Sunny & Ranney** — a home goods store in Roswell, GA where 100% of profits go to **Sunshine on a Ranney Day**, a charity that provides home makeovers for children with special needs.

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

## Rules
- Warm, concise (2-4 sentences unless detail is requested). Use **bold** for key info.
- When recommending products, include the name, price, and link formatted as [Product Name](/shop/handle).
- If a product is SOLD OUT, let the customer know and suggest similar items.
- If asked about something not in the provided products, say inventory changes often and suggest they visit in person or browse /shop.
- Never invent products that aren't in the provided context.
- Occasionally mention the mission — customers love knowing their purchase matters.
- If a customer seems to be browsing, proactively suggest 2-3 relevant items from the provided products.`;

// ─── Helpers ─────────────────────────────────────────────────

function formatProductForLLM(meta: Product): string {
  const price = parseFloat(meta.price).toFixed(2);
  const compareAt = parseFloat(meta.compareAtPrice || '0');
  const onSale = compareAt > parseFloat(price);
  return [
    `**${meta.title}**`,
    `$${price}${onSale ? ` (was $${compareAt.toFixed(2)})` : ''}`,
    meta.productType ? `Category: ${meta.productType}` : '',
    !meta.availableForSale ? 'SOLD OUT' : '',
    `[View](/shop/${meta.handle})`,
  ].filter(Boolean).join(' | ');
}

/** Build the user's latest query for embedding — uses last user message + recent context */
function getSearchQuery(messages: { role: string; content: string }[]): string {
  const userMessages = messages.filter(m => m.role === 'user');
  // Use last 2 user messages for better context
  return userMessages.slice(-2).map(m => m.content).join(' ');
}

// ─── RAG: embed query → search Vectorize → retrieve relevant products ───

async function searchProducts(
  ai: any,
  vectorize: any,
  query: string,
  topK = 15,
): Promise<string> {
  // Generate embedding for the user's query
  const embeddingResult = await ai.run('@cf/baai/bge-base-en-v1.5', {
    text: [query],
  });

  const queryVector = embeddingResult.data?.[0];
  if (!queryVector) return 'No products found.';

  // Search Vectorize for the most relevant products
  const results = await vectorize.query(queryVector, {
    topK,
    returnMetadata: 'all',
  });

  if (!results.matches?.length) return 'No matching products found.';

  // Format matched products for the LLM
  const products = results.matches
    .filter((m: any) => m.metadata)
    .map((m: any) => formatProductForLLM(m.metadata as Product));

  return products.join('\n');
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
    const vectorize = runtime?.env?.VECTORIZE;

    if (!ai) {
      return new Response(
        JSON.stringify({ error: 'AI binding not available.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // RAG: search for relevant products based on user's query
    let productContext = '';
    if (vectorize) {
      const query = getSearchQuery(messages);
      productContext = await searchProducts(ai, vectorize, query);
    }

    // Build messages with product context injected
    const systemMessage = { role: 'system', content: SYSTEM_PROMPT };
    const contextMessage = productContext
      ? { role: 'system', content: `## Relevant Products From Our Shop\n${productContext}` }
      : null;

    const llmMessages = [
      systemMessage,
      ...(contextMessage ? [contextMessage] : []),
      ...messages,
    ];

    const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: llmMessages,
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
