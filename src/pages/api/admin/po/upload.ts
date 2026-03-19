import type { APIRoute } from 'astro';
import { parsePurchaseOrderPDF } from '@/lib/pdf-parser';
import { createPurchaseOrder, createLineItems, updatePurchaseOrder } from '@/lib/po-db';
import { findMatchingProduct } from '@/lib/shopify-admin';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10 MB

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ error: 'Expected multipart/form-data' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    const formData = await request.formData();
    const file = formData.get('pdf') as File | null;

    if (!file || !file.name) {
      return new Response(
        JSON.stringify({ error: 'No PDF file provided' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    if (file.size > MAX_PDF_SIZE) {
      return new Response(
        JSON.stringify({ error: 'PDF too large (max 10 MB)' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    // Convert PDF to base64 for Claude
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
    );

    // Parse with Claude
    const parsed = await parsePurchaseOrderPDF(base64, file.name);

    // Create the PO in D1
    const poId = await createPurchaseOrder({
      supplier_name: parsed.supplier_name,
      po_number: parsed.po_number,
      pdf_filename: file.name,
      status: 'reviewing',
      raw_parsed_json: JSON.stringify(parsed),
    });

    // Match each line item against Shopify
    const itemsWithMatches = await Promise.all(
      parsed.line_items.map(async (item) => {
        try {
          const match = await findMatchingProduct(item.sku, item.product_name);
          if (match) {
            const variant = match.product.variants.edges[0]?.node;
            const image = match.product.images.edges[0]?.node;
            return {
              product_name: item.product_name,
              sku: item.sku || variant?.sku || '',
              quantity: item.quantity,
              unit_cost: item.unit_cost,
              description: item.description,
              shopify_product_id: match.product.id,
              shopify_variant_id: variant?.id || '',
              match_status: 'matched' as const,
              match_confidence: match.confidence,
              image_url: image?.url || '',
              image_source: image?.url ? 'shopify_existing' : '',
            };
          }
        } catch (err) {
          console.error(`Match error for "${item.product_name}":`, err);
        }

        return {
          product_name: item.product_name,
          sku: item.sku,
          quantity: item.quantity,
          unit_cost: item.unit_cost,
          description: item.description,
          match_status: 'new' as const,
          match_confidence: 0,
        };
      }),
    );

    // Store line items
    await createLineItems(poId, itemsWithMatches);

    return new Response(
      JSON.stringify({ id: poId, supplier: parsed.supplier_name, items: itemsWithMatches.length }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (err: any) {
    console.error('PO upload error:', err?.message || err);
    return new Response(
      JSON.stringify({ error: err?.message || 'Failed to process PDF' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};
