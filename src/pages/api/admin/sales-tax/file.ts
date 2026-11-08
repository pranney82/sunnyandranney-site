import type { APIRoute } from 'astro';
import { dbOf, json, requireRole } from '@/lib/admin-http';
import { monthFile } from '@/lib/sales-tax/status.mjs';

export const prerender = false;

/** Shopify's report for a month, as the sales-tax worker kept it: ?month=2026-10&kind=pdf|csv. Managers only. */
export const GET: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const month = context.url.searchParams.get('month') ?? '';
  const kind = context.url.searchParams.get('kind') ?? '';
  const file = await monthFile(dbOf(context), month, kind);
  if (!file) return json({ error: 'There’s no file kept for that month.' }, 404);

  const ascii = file.filename.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '');
  return new Response(file.body, {
    headers: {
      'Content-Type': file.type,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
