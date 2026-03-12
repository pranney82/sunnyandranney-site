import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Messages array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Access the Cloudflare AI binding from the runtime environment
    const runtime = (locals as any).runtime;
    const ai = runtime?.env?.AI;

    if (!ai) {
      return new Response(
        JSON.stringify({ error: 'AI binding not available. Make sure AI is enabled in wrangler.toml.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const systemMessage = {
      role: 'system',
      content: `You are Stacy, a friendly and helpful shopping assistant for Sunny & Ranney — an online store that sells stylish, comfortable clothing and accessories. 100% of profits go to charity. You help customers find products, answer questions about sizing, shipping, and returns, and share the brand's mission. Keep responses concise, warm, and helpful. If you don't know something specific about inventory, suggest the customer browse the shop or contact support.`,
    };

    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [systemMessage, ...messages],
      max_tokens: 512,
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
