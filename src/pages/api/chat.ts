import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSetting, checkRateLimit, getSession, upsertSession, cleanExpiredSessions, getProductAvailability } from '@/lib/db';

export const prerender = false;

// ─── Constants ──────────────────────────────────────────────
const MAX_HISTORY = 20;
const MAX_INPUT_LENGTH = 500;
const MAX_TOKENS = 2048;
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 20;
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const SESSION_SUMMARY_THRESHOLD = 30;
const SESSION_TRUNCATE_TO = 10;

// ─── Types ───────────────────────────────────────────────────
interface Product {
  title: string;
  handle: string;
  productType: string;
  description?: string;
  tags?: string;
  availableForSale: boolean;
  price: string;
  compareAtPrice: string;
  imageUrl?: string;
}

/** Subset of Product sent to the frontend for product cards */
interface ProductCard {
  cardIndex: number;
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
- Keep paragraphs short (2-3 sentences max). Use line breaks between distinct points for readability.
- Use bullet lists for 3+ items — they're easier to scan than dense paragraphs.
- When recommending products, ALWAYS include a clickable link for EACH product mentioned. Format: [Product Name](/shop/handle). Example: "I'd recommend the [Vintage Oak Console](/shop/vintage-oak-console) ($299)." Reference the product number (e.g. **#1**) so customers can match it to the cards below. NEVER mention a product without its link.
- Only recommend products from the "Relevant Products" section below — these are all in stock and available for purchase.
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

async function buildSystemPrompt(pageContext?: PageContext, sessionSummary?: string): Promise<string> {
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

  if (sessionSummary) {
    basePrompt += `\n\n## Previous Conversation Summary\nThis customer has chatted with you before. Here's a summary of your earlier conversation:\n${sessionSummary}`;
  }

  if (pageContext?.url) {
    const titleNote = pageContext.title ? ` — "${pageContext.title}"` : '';
    basePrompt += `\n\n## Customer's Current Page\nThe customer is currently browsing: ${pageContext.url}${titleNote}\nUse this context to give more relevant suggestions.`;
  }

  return basePrompt;
}

// ─── Helpers ─────────────────────────────────────────────────

function formatProductForLLM(meta: Product, index: number): string {
  const price = parseFloat(meta.price).toFixed(2);
  const compareAt = parseFloat(meta.compareAtPrice || '0');
  const onSale = compareAt > parseFloat(price);
  const parts = [
    `**#${index + 1} [${meta.title}](/shop/${meta.handle})**`,
    `$${price}${onSale ? ` (was $${compareAt.toFixed(2)})` : ''}`,
    meta.productType ? `Category: ${meta.productType}` : '',
    meta.description || '',
    meta.tags ? `Tags: ${meta.tags}` : '',
    !meta.availableForSale ? 'SOLD OUT' : '',
  ];
  return parts.filter(Boolean).join(' | ');
}

function getSearchQuery(messages: ChatMessage[]): string {
  const userMessages = messages.filter(m => m.role === 'user');
  const query = userMessages.slice(-2).map(m => m.content).join(' ');
  // Query expansion: for short queries, add last assistant message for context
  if (query.length < 20) {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant) return query + ' ' + lastAssistant.content.slice(0, 100);
  }
  return query;
}

// ─── RAG ─────────────────────────────────────────────────────

interface SearchResult {
  llmContext: string;
  cards: ProductCard[];
}


async function searchProducts(ai: any, vectorize: any, query: string, topK = 10): Promise<SearchResult> {
  const embeddingResult = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
  const queryVector = embeddingResult.data?.[0];
  if (!queryVector) return { llmContext: 'No products found.', cards: [] };

  const results = await vectorize.query(queryVector, { topK, returnMetadata: 'all' });
  if (!results.matches?.length) return { llmContext: 'No matching products found.', cards: [] };

  // Filter against the valid product handles stored in D1 by sync-products.
  // Also apply a similarity score threshold to remove noise.
  let validHandles: Set<string> | null = null;
  try {
    const row = await getSetting<string[]>('settings:valid_product_handles');
    if (row) validHandles = new Set(row);
  } catch { /* fall through — skip filter if D1 is unavailable */ }

  const allProducts = results.matches
    .filter((m: any) => m.metadata && m.score >= 0.35 && (!validHandles || validHandles.has(m.id)))
    .map((m: any) => m.metadata as Product);

  // Check real-time availability from D1 (updated by Shopify webhooks, vector metadata may be stale)
  const handles = allProducts.map((p: Product) => p.handle);
  const realTimeAvailability = await getProductAvailability(handles);

  // Only show available products to the LLM - use real-time data if available, fall back to cached
  const products = allProducts.filter((p: Product) => {
    const realTime = realTimeAvailability.get(p.handle);
    return realTime !== undefined ? realTime : p.availableForSale;
  });

  const llmContext = products.map((p: Product, i: number) => formatProductForLLM(p, i)).join('\n');

  // Top 4 available products with images for rich cards — track original index
  const indexed: Array<{ product: Product; index: number }> = products.map((p: Product, i: number) => ({ product: p, index: i }));
  const cards: ProductCard[] = indexed
    .filter((item: { product: Product; index: number }) => item.product.availableForSale && item.product.imageUrl)
    .slice(0, 4)
    .map((item: { product: Product; index: number }) => ({
      cardIndex: item.index + 1,
      title: item.product.title,
      handle: item.product.handle,
      price: parseFloat(item.product.price).toFixed(2),
      compareAtPrice: parseFloat(item.product.compareAtPrice || '0').toFixed(2),
      availableForSale: item.product.availableForSale,
      imageUrl: item.product.imageUrl || '',
    }));

  return { llmContext, cards };
}

// ─── Anthropic streaming adapter ─────────────────────────────
// Transforms Anthropic SSE events into the format the frontend expects:
// data: {"response":"token"}\n\n

function createAnthropicStream(
  anthropicBody: ReadableStream,
  productCards: ProductCard[],
): ReadableStream {
  const encoder = new TextEncoder();
  const productsEvent = productCards.length
    ? `data: ${JSON.stringify({ products: productCards })}\n\n`
    : '';

  return new ReadableStream({
    async start(controller) {
      if (productsEvent) controller.enqueue(encoder.encode(productsEvent));

      const reader = anthropicBody.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ response: parsed.delta.text })}\n\n`
              ));
            }
          } catch { /* skip malformed chunks */ }
        }
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// ─── Workers AI streaming adapter (passthrough + products) ───

function createWorkersAIStream(
  eventStream: ReadableStream,
  productCards: ProductCard[],
): ReadableStream {
  const encoder = new TextEncoder();
  const productsEvent = productCards.length
    ? `data: ${JSON.stringify({ products: productCards })}\n\n`
    : '';

  return new ReadableStream({
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
}

// ─── Session summary generation ──────────────────────────────

async function generateSummary(
  messages: ChatMessage[],
  useAnthropic: boolean,
): Promise<string> {
  const summaryPrompt = 'Summarize this customer conversation in 2-3 sentences. Focus on what products they were interested in, any preferences mentioned, and where the conversation left off.';
  const conversationText = messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(0, 3000);

  try {
    if (useAnthropic && env.ANTHROPIC_API_KEY) {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 200,
          system: summaryPrompt,
          messages: [{ role: 'user', content: conversationText }],
        }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        return data.content?.[0]?.text || '';
      }
    } else {
      const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: summaryPrompt },
          { role: 'user', content: conversationText },
        ],
        max_tokens: 200,
      }) as { response?: string };
      return result.response || '';
    }
  } catch (err) {
    console.error('Summary generation error:', err);
  }
  return '';
}

// ─── API handler ──────────────────────────────────────────────
export const POST: APIRoute = async ({ request }) => {
  try {
    // Probabilistic session cleanup (1 in 100)
    if (Math.random() < 0.01) {
      cleanExpiredSessions().catch(() => {});
    }

    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const allowed = await checkRateLimit(`chat:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Too many messages. Please wait a moment and try again.' }), {
        status: 429,
        headers: JSON_HEADERS,
      });
    }

    const body = await request.json() as {
      messages?: ChatMessage[];
      stream?: boolean;
      pageContext?: PageContext;
      sessionId?: string;
    };
    const { messages, stream = false, pageContext, sessionId } = body;

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
    const useAnthropic = !!env.ANTHROPIC_API_KEY;

    if (!ai && !useAnthropic) {
      return new Response(JSON.stringify({ error: 'AI service unavailable.' }), { status: 503, headers: JSON_HEADERS });
    }

    const trimmedMessages: ChatMessage[] = messages.slice(-MAX_HISTORY);

    // ─── Load session summary from D1 ──────────────────────
    let sessionSummary = '';
    if (sessionId) {
      try {
        const session = await getSession(sessionId);
        if (session?.summary) sessionSummary = session.summary;
      } catch { /* ignore — session is a bonus, not critical */ }
    }

    // ─── RAG search ────────────────────────────────────────
    let productContext = '';
    let productCards: ProductCard[] = [];
    if (vectorize && ai) {
      try {
        const query = getSearchQuery(trimmedMessages);
        const result = await searchProducts(ai, vectorize, query);
        productContext = result.llmContext;
        productCards = result.cards;
      } catch (err: any) {
        console.error('RAG search failed (continuing without products):', err?.message);
      }
    }

    const systemPrompt = await buildSystemPrompt(pageContext, sessionSummary);
    const fullSystem = systemPrompt + (productContext ? `\n\n## Relevant Products From Our Shop\n${productContext}` : '');

    // ─── Streaming response ────────────────────────────────
    if (stream) {
      let combinedStream: ReadableStream;

      if (useAnthropic) {
        // Anthropic Messages API
        const anthropicRes = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY!,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: MAX_TOKENS,
            system: fullSystem,
            messages: trimmedMessages.map(m => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
            stream: true,
          }),
        });

        if (!anthropicRes.ok || !anthropicRes.body) {
          // Fallback to Workers AI on Anthropic failure
          if (ai) {
            const eventStream = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
              messages: [{ role: 'system', content: fullSystem }, ...trimmedMessages],
              max_tokens: MAX_TOKENS,
              stream: true,
            }) as ReadableStream;
            combinedStream = createWorkersAIStream(eventStream, productCards);
          } else {
            throw new Error('Both Anthropic and Workers AI unavailable');
          }
        } else {
          combinedStream = createAnthropicStream(anthropicRes.body, productCards);
        }
      } else {
        // Workers AI
        const eventStream = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'system', content: fullSystem }, ...trimmedMessages],
          max_tokens: MAX_TOKENS,
          stream: true,
        }) as ReadableStream;
        combinedStream = createWorkersAIStream(eventStream, productCards);
      }

      // Save session to D1 in the background (don't block response)
      if (sessionId) {
        const sessionMessages = [...trimmedMessages];
        // We don't have the assistant reply yet (it's streaming), so save what we have.
        // The next request will include the assistant reply in the messages array.
        saveSessionBackground(sessionId, sessionMessages, useAnthropic);
      }

      return new Response(combinedStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // ─── Non-streaming response ────────────────────────────
    let reply = '';

    if (useAnthropic) {
      const anthropicRes = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: MAX_TOKENS,
          system: fullSystem,
          messages: trimmedMessages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
        }),
      });

      if (anthropicRes.ok) {
        const data = await anthropicRes.json() as any;
        reply = data.content?.[0]?.text || '';
      } else if (ai) {
        // Fallback
        const result = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'system', content: fullSystem }, ...trimmedMessages],
          max_tokens: MAX_TOKENS,
        }) as { response?: string };
        reply = result.response || '';
      }
    } else {
      const result = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [{ role: 'system', content: fullSystem }, ...trimmedMessages],
        max_tokens: MAX_TOKENS,
      }) as { response?: string };
      reply = result.response || '';
    }

    // Save session
    if (sessionId) {
      const sessionMessages = [...trimmedMessages, { role: 'assistant', content: reply }];
      saveSessionBackground(sessionId, sessionMessages, useAnthropic);
    }

    return new Response(JSON.stringify({ reply, products: productCards }), { headers: JSON_HEADERS });

  } catch (err: any) {
    console.error('Chat API error:', err?.message);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
};

// ─── Background session persistence ──────────────────────────
// Fire-and-forget: saves messages to D1, generates summary if needed.

function saveSessionBackground(
  sessionId: string,
  messages: ChatMessage[],
  useAnthropic: boolean,
): void {
  (async () => {
    try {
      // If conversation is long, generate a summary and truncate
      if (messages.length > SESSION_SUMMARY_THRESHOLD) {
        const summary = await generateSummary(messages, useAnthropic);
        const truncated = messages.slice(-SESSION_TRUNCATE_TO);
        await upsertSession(sessionId, truncated, summary);
      } else {
        await upsertSession(sessionId, messages);
      }
    } catch (err) {
      console.error('Background session save error:', err);
    }
  })();
}
