import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSetting, checkRateLimit } from '@/lib/db';

export const prerender = false;

// ─── Constants ──────────────────────────────────────────────
const MAX_HISTORY = 20;
const MAX_INPUT_LENGTH = 500;
const MAX_TOKENS = 1024;
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 20;

// ─── Types ───────────────────────────────────────────────────
interface Product {
  title: string;
  handle: string;
  productType: string;
  availableForSale: boolean;
  price: string;
  compareAtPrice: string;
  imageUrl?: string;
}

/** Subset of Product sent to the frontend for product cards */
interface ProductCard {
  title: string;
  handle: string;
  price: string;
  compareAtPrice: string;
  availableForSale: boolean;
  imageUrl: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface PageContext {
  url: string;
  title: string;
}

// Module-level cache — avoids 2 D1 reads on every chat message.
let _promptCache: { prompt: string; ts: number } | null = null;
const PROMPT_CACHE_TTL_MS = 60_000;

// ─── System prompt ────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are Staci, the AI shopping assistant for **Sunny & Ranney** — a home goods store in Roswell, GA where 100% of profits go to **Sunshine on a Ranney Day**, a charity that provides home makeovers for children with special needs.

## Store Details
- **What we sell:** Furniture, home decor, lighting, gifts, kitchenware, and accessories. New inventory arrives regularly.
- **Pickup:** LOCAL PICKUP ONLY — we do not ship. All orders are picked up from our Roswell showroom.
- **Location:** 109A Oak Street, Roswell, GA 30075
- **Phone:** 678.888.5140
- **Email:** info@sunnyandranney.com
- **Website:** sunnyandranney.com
- **Returns & Refunds:** All sales are final — **no refunds**. We accept exchanges within 14 days with original receipt. Items must be in original condition. No exchanges on sale items.
- **Payment:** We accept all major credit cards and cash.

## About Sunshine on a Ranney Day (SOARD)
- **Founded:** 2012 by **Peter and Holly Ranney** in Roswell, GA.
- **Status:** 501(c)(3) nonprofit (EIN: 45-4773997).
- **Origin:** Inspired by a church sermon to use their talents and resources to help others. Their first project in July 2012 was for 11-year-old Mathew, who wanted to spend his final days in a military-themed bedroom. That transformative experience shaped the organization's mission.
- **Mission:** SOARD creates life-changing home makeovers — dream bedrooms, accessible bathrooms, and therapy rooms — for children with special needs in the greater Atlanta area, all at **no cost** to families.
- **Services:** Wheelchair-accessible bathroom renovations, dream bedroom makeovers, and in-home therapy room design.
- **Service area:** Greater Atlanta area (~80-mile radius).
- **Credentials:** Charity Navigator 3-star rating, GuideStar Transparency Seal, licensed Georgia contractor.
- **SOARD contact:** info@soardcharity.com | 770-990-2434 | sunshineonaranneyday.com
- Sunny & Ranney exists to fund SOARD. Every single dollar of profit goes directly to these makeovers. When a customer buys from us, they are directly changing a child's life.

## Rules
- Warm and helpful. Be concise but give complete answers — never cut off useful information. Use **bold** for key info.
- When recommending products, include the name, price, and link formatted as [Product Name](/shop/handle).
- If a product is SOLD OUT, let the customer know and suggest similar items.
- If asked about something not in the provided products, say inventory changes often and suggest they visit in person or browse /shop.
- Never invent products that aren't in the provided context.
- **NEVER fabricate details about SOARD, its founders, or its history.** Only share what is provided above. For deeper questions, direct customers to sunshineonaranneyday.com.
- If a customer seems to be browsing, proactively suggest 2-3 relevant items from the provided products.
- Occasionally (not every message, but roughly every 3rd or 4th response) end with: "Remember, every purchase you make at Sunny & Ranney supports a great cause — 100% of our profits go to Sunshine on a Ranney Day, which provides home makeovers for children with special needs."
- At the end of EVERY response, include exactly 2-3 suggested follow-up questions the customer might want to ask next. Each suggestion must be on its own line starting with "?>" (e.g. "?>What furniture do you have?"). Keep each under 40 characters. Make them contextual to the conversation. NEVER ask about the customer's budget.`;

const DEFAULT_HOURS = '**Hours (Eastern):** Tuesday–Saturday, 10 AM–6 PM. Closed Sunday & Monday.';

interface StoreHours {
  days: Array<{ day: string; open: string; close: string; closed: boolean }>;
  holidays: Array<{ date: string; label: string; closed: boolean; open: string; close: string }>;
  note: string;
}

interface StoreSpecials {
  promoCode: string;
  promoDescription: string;
  featuredHandle: string;
  announcements: Array<{ text: string; active: boolean; type: string }>;
}

/** Convert "14:00" or "18:00" to "2:00 PM"; pass through if already in 12-hour format */
function to12Hour(time: string): string {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return time; // already formatted like "10am"
  let h = parseInt(match[1], 10);
  const m = match[2];
  const suffix = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return m === '00' ? `${h} ${suffix}` : `${h}:${m} ${suffix}`;
}

function formatHoursForPrompt(hours: StoreHours): string {
  const lines = hours.days.map((d) => {
    if (d.closed) return `- ${d.day}: Closed`;
    return `- ${d.day}: ${to12Hour(d.open)}–${to12Hour(d.close)}`;
  });

  let result = `**Hours (all times Eastern):**\n${lines.join('\n')}`;

  if (hours.holidays?.length) {
    const upcoming = hours.holidays.slice(0, 5);
    const holidayLines = upcoming.map((h) => {
      if (h.closed) return `- ${h.label} (${h.date}): Closed`;
      return `- ${h.label} (${h.date}): ${to12Hour(h.open)}–${to12Hour(h.close)}`;
    });
    result += `\n**Holiday Hours:**\n${holidayLines.join('\n')}`;
  }

  if (hours.note) result += `\n**Note:** ${hours.note}`;

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

async function buildSystemPrompt(pageContext?: PageContext): Promise<string> {
  let basePrompt: string;

  if (_promptCache && Date.now() - _promptCache.ts < PROMPT_CACHE_TTL_MS) {
    basePrompt = _promptCache.prompt;
  } else {
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

    _promptCache = { prompt, ts: Date.now() };
    basePrompt = prompt;
  }

  if (pageContext?.url) {
    const titleNote = pageContext.title ? ` — "${pageContext.title}"` : '';
    basePrompt += `\n\n## Customer's Current Page\nThe customer is currently browsing: ${pageContext.url}${titleNote}\nUse this context to give more relevant suggestions.`;
  }

  return basePrompt;
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

function getSearchQuery(messages: ChatMessage[]): string {
  const userMessages = messages.filter(m => m.role === 'user');
  return userMessages.slice(-2).map(m => m.content).join(' ');
}

// ─── RAG ─────────────────────────────────────────────────────

interface SearchResult {
  llmContext: string;
  cards: ProductCard[];
}

async function searchProducts(ai: any, vectorize: any, query: string, topK = 15): Promise<SearchResult> {
  const embeddingResult = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
  const queryVector = embeddingResult.data?.[0];
  if (!queryVector) return { llmContext: 'No products found.', cards: [] };

  const results = await vectorize.query(queryVector, { topK, returnMetadata: 'all' });
  if (!results.matches?.length) return { llmContext: 'No matching products found.', cards: [] };

  const products = results.matches
    .filter((m: any) => m.metadata)
    .map((m: any) => m.metadata as Product);

  const llmContext = products.map(formatProductForLLM).join('\n');

  // Top 4 available products with images for rich cards
  const cards: ProductCard[] = products
    .filter((p: Product) => p.availableForSale && p.imageUrl)
    .slice(0, 4)
    .map((p: Product) => ({
      title: p.title,
      handle: p.handle,
      price: parseFloat(p.price).toFixed(2),
      compareAtPrice: parseFloat(p.compareAtPrice || '0').toFixed(2),
      availableForSale: p.availableForSale,
      imageUrl: p.imageUrl || '',
    }));

  return { llmContext, cards };
}

// ─── API handler ──────────────────────────────────────────────
export const POST: APIRoute = async ({ request }) => {
  try {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const allowed = await checkRateLimit(`chat:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Too many messages. Please wait a moment and try again.' }), {
        status: 429,
        headers: JSON_HEADERS,
      });
    }

    const body = await request.json() as { messages?: ChatMessage[]; stream?: boolean; pageContext?: PageContext };
    const { messages, stream = false, pageContext } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Messages array required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

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
      return new Response(JSON.stringify({ error: 'AI service unavailable.' }), { status: 503, headers: JSON_HEADERS });
    }

    const trimmedMessages: ChatMessage[] = messages.slice(-MAX_HISTORY);

    let productContext = '';
    let productCards: ProductCard[] = [];
    if (vectorize) {
      const query = getSearchQuery(trimmedMessages);
      const result = await searchProducts(ai, vectorize, query);
      productContext = result.llmContext;
      productCards = result.cards;
    }

    const systemPrompt = await buildSystemPrompt(pageContext);
    const fullSystem = systemPrompt + (productContext ? `\n\n## Relevant Products From Our Shop\n${productContext}` : '');

    const llmMessages = [
      { role: 'system', content: fullSystem },
      ...trimmedMessages,
    ];

    if (stream) {
      const eventStream = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: llmMessages,
        max_tokens: MAX_TOKENS,
        stream: true,
      }) as ReadableStream;

      // Prepend a products SSE event before the LLM stream
      const encoder = new TextEncoder();
      const productsEvent = productCards.length
        ? `data: ${JSON.stringify({ products: productCards })}\n\n`
        : '';

      const combined = new ReadableStream({
        async start(controller) {
          if (productsEvent) controller.enqueue(encoder.encode(productsEvent));
          const reader = eventStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        },
      });

      return new Response(combined, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: llmMessages,
      max_tokens: MAX_TOKENS,
    }) as { response?: string };

    return new Response(JSON.stringify({ reply: response.response, products: productCards }), { headers: JSON_HEADERS });

  } catch (err: any) {
    console.error('Chat API error:', err?.message);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
};
