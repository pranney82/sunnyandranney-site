import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSetting, checkRateLimit } from '@/lib/db';

export const prerender = false;

// ─── Constants ──────────────────────────────────────────────
const MAX_HISTORY = 20;
const MAX_INPUT_LENGTH = 500;
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX = 20; // max messages per window

// ─── Types ───────────────────────────────────────────────────
interface Product {
  title: string;
  handle: string;
  productType: string;
  availableForSale: boolean;
  price: string;
  compareAtPrice: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

// ─── System prompt (base — hours/specials injected dynamically from D1) ──
const BASE_SYSTEM_PROMPT = `You are Staci, the AI shopping assistant for **Sunny & Ranney** — a home goods store in Roswell, GA where 100% of profits go to **Sunshine on a Ranney Day**, a charity that provides home makeovers for children with special needs.

## Store Details
- **What we sell:** Furniture, home decor, lighting, gifts, kitchenware, and accessories. New inventory arrives regularly.
- **Pickup:** LOCAL PICKUP ONLY — we do not ship. All orders are picked up from our Roswell showroom.
- **Location:** Roswell, GA (customers can find directions on our website)
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

// Default hours if not configured in admin
const DEFAULT_HOURS = '**Hours:** Tuesday–Saturday, 10am–6pm. Closed Sunday & Monday.';

interface StoreHours {
  days: Array<{ day: string; open: string; close: string; closed: boolean }>;
  holidays: Array<{ date: string; label: string }>;
  note: string;
}

interface StoreSpecials {
  promoCode: string;
  promoDescription: string;
  featuredHandle: string;
  announcements: Array<{ text: string; active: boolean; type: string }>;
}

function formatHoursForPrompt(hours: StoreHours): string {
  const lines = hours.days.map((d) => {
    if (d.closed) return `- ${d.day}: Closed`;
    return `- ${d.day}: ${d.open}–${d.close}`;
  });

  let result = `**Hours:**\n${lines.join('\n')}`;

  if (hours.holidays?.length) {
    const upcoming = hours.holidays.slice(0, 5);
    result += `\n**Holiday Closures:** ${upcoming.map((h) => `${h.label} (${h.date})`).join(', ')}`;
  }

  if (hours.note) {
    result += `\n**Note:** ${hours.note}`;
  }

  return result;
}

function formatSpecialsForPrompt(specials: StoreSpecials): string {
  const parts: string[] = [];

  if (specials.promoCode && specials.promoDescription) {
    parts.push(`**Current Promo:** Use code **${specials.promoCode}** — ${specials.promoDescription}`);
  }

  const activeAnnouncements = specials.announcements?.filter((a) => a.active);
  if (activeAnnouncements?.length) {
    parts.push(`**Announcements:** ${activeAnnouncements.map((a) => a.text).join('. ')}`);
  }

  return parts.join('\n');
}

async function buildSystemPrompt(): Promise<string> {
  let hoursSection = DEFAULT_HOURS;
  let specialsSection = '';

  try {
    const [hours, specials] = await Promise.all([
      getSetting<StoreHours>('settings:hours'),
      getSetting<StoreSpecials>('settings:specials'),
    ]);

    if (hours) hoursSection = formatHoursForPrompt(hours);
    if (specials) specialsSection = formatSpecialsForPrompt(specials);
  } catch {
    // Fall back to defaults
  }

  let prompt = BASE_SYSTEM_PROMPT + `\n\n${hoursSection}`;
  if (specialsSection) prompt += `\n\n${specialsSection}`;

  return prompt;
}

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

/** Build the user's latest query for embedding — uses last 2 user messages for context */
function getSearchQuery(messages: ChatMessage[]): string {
  const userMessages = messages.filter(m => m.role === 'user');
  return userMessages.slice(-2).map(m => m.content).join(' ');
}

// ─── RAG: embed query → search Vectorize → retrieve relevant products ───

async function searchProducts(
  ai: any,
  vectorize: any,
  query: string,
  topK = 15,
): Promise<string> {
  const embeddingResult = await ai.run('@cf/baai/bge-base-en-v1.5', {
    text: [query],
  });

  const queryVector = embeddingResult.data?.[0];
  if (!queryVector) return 'No products found.';

  const results = await vectorize.query(queryVector, {
    topK,
    returnMetadata: 'all',
  });

  if (!results.matches?.length) return 'No matching products found.';

  const products = results.matches
    .filter((m: any) => m.metadata)
    .map((m: any) => formatProductForLLM(m.metadata as Product));

  return products.join('\n');
}

// ─── API handler (streaming via SSE) ─────────────────────────
export const POST: APIRoute = async ({ request }) => {
  try {
    // Rate limit by IP
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const allowed = await checkRateLimit(`chat:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Too many messages. Please wait a moment and try again.' }), {
        status: 429,
        headers: JSON_HEADERS,
      });
    }

    const body = await request.json() as { messages?: ChatMessage[]; stream?: boolean };
    const { messages, stream = false } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Messages array required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    // Validate the latest user message length
    const lastUserMsg = [...messages].reverse().find((m: ChatMessage) => m.role === 'user');
    if (lastUserMsg && lastUserMsg.content.length > MAX_INPUT_LENGTH) {
      return new Response(JSON.stringify({ error: 'Message too long. Please keep it under 500 characters.' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const ai = env.AI;
    const vectorize = env.VECTORIZE;

    if (!ai) {
      return new Response(
        JSON.stringify({ error: 'AI service unavailable.' }),
        { status: 503, headers: JSON_HEADERS }
      );
    }

    // Trim conversation history to last N messages to control token usage
    const trimmedMessages: ChatMessage[] = messages.slice(-MAX_HISTORY);

    // RAG: search for relevant products based on user's query
    let productContext = '';
    if (vectorize) {
      const query = getSearchQuery(trimmedMessages);
      productContext = await searchProducts(ai, vectorize, query);
    }

    // Build system prompt with dynamic hours/specials from D1
    const systemPrompt = await buildSystemPrompt();

    // Build messages with product context injected
    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...(productContext
        ? [{ role: 'system', content: `## Relevant Products From Our Shop\n${productContext}` }]
        : []),
      ...trimmedMessages,
    ];

    // ─── Streaming path ───────────────────────────────────────
    if (stream) {
      const eventStream = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: llmMessages,
        max_tokens: 400,
        stream: true,
      });

      // Workers AI returns an SSE ReadableStream — pipe it through
      return new Response(eventStream as ReadableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // ─── Non-streaming fallback ────────────────────────────────
    const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: llmMessages,
      max_tokens: 400,
    }) as { response?: string };

    return new Response(JSON.stringify({ reply: response.response }), {
      headers: JSON_HEADERS,
    });
  } catch (err: any) {
    console.error('Chat API error:', err?.message);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
};
