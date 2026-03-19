import type { APIRoute } from 'astro';
import { getPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder } from '@/lib/po-db';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const GET: APIRoute = async ({ params }) => {
  try {
    const po = await getPurchaseOrder(params.id!);
    if (!po) {
      return new Response(
        JSON.stringify({ error: 'Purchase order not found' }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify(po), { headers: JSON_HEADERS });
  } catch (err: any) {
    console.error('PO get error:', err?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to get purchase order' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};

export const PATCH: APIRoute = async ({ params, request }) => {
  try {
    const body = await request.json();
    const updated = await updatePurchaseOrder(params.id!, body);
    if (!updated) {
      return new Response(
        JSON.stringify({ error: 'Purchase order not found or no changes' }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err: any) {
    console.error('PO update error:', err?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to update purchase order' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const deleted = await deletePurchaseOrder(params.id!);
    if (!deleted) {
      return new Response(
        JSON.stringify({ error: 'Purchase order not found' }),
        { status: 404, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err: any) {
    console.error('PO delete error:', err?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to delete purchase order' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};
