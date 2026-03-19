import type { APIRoute } from 'astro';
import { listPurchaseOrders } from '@/lib/po-db';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const GET: APIRoute = async ({ url }) => {
  try {
    const status = url.searchParams.get('status') as any || undefined;
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));

    const result = await listPurchaseOrders(status, page);

    return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
  } catch (err: any) {
    console.error('PO list error:', err?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to list purchase orders' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};
