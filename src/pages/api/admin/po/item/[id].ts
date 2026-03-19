import type { APIRoute } from 'astro';
import { updateLineItem, getLineItem } from '@/lib/po-db';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const PATCH: APIRoute = async ({ params, request }) => {
  try {
    const body = await request.json();

    // Whitelist allowed fields
    const allowed: Record<string, unknown> = {};
    const fields = [
      'product_name', 'sku', 'quantity', 'unit_cost', 'retail_price',
      'description', 'match_status', 'image_url', 'image_source',
      'shopify_product_id', 'shopify_variant_id',
    ] as const;

    for (const field of fields) {
      if (body[field] !== undefined) {
        allowed[field] = body[field];
      }
    }

    const updated = await updateLineItem(params.id!, allowed);
    if (!updated) {
      return new Response(
        JSON.stringify({ error: 'Line item not found or no changes' }),
        { status: 404, headers: JSON_HEADERS },
      );
    }

    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err: any) {
    console.error('Line item update error:', err?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to update line item' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};

export const GET: APIRoute = async ({ params }) => {
  try {
    const item = await getLineItem(params.id!);
    if (!item) {
      return new Response(
        JSON.stringify({ error: 'Line item not found' }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify(item), { headers: JSON_HEADERS });
  } catch (err: any) {
    console.error('Line item get error:', err?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to get line item' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};
