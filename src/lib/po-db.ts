/**
 * D1 CRUD helpers for purchase orders and line items.
 * Follows the same patterns as src/lib/db.ts.
 */
import { env } from 'cloudflare:workers';

// ─── Types ───────────────────────────────────────────────────

export type POStatus = 'draft' | 'reviewing' | 'approved' | 'completed' | 'failed';
export type MatchStatus = 'unmatched' | 'matched' | 'new' | 'created' | 'skipped';

export interface PurchaseOrder {
  id: string;
  supplier_name: string;
  po_number: string;
  pdf_filename: string;
  status: POStatus;
  raw_parsed_json: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface POLineItem {
  id: string;
  po_id: string;
  line_number: number;
  product_name: string;
  sku: string;
  quantity: number;
  unit_cost: number;
  retail_price: number;
  description: string;
  shopify_product_id: string;
  shopify_variant_id: string;
  match_status: MatchStatus;
  match_confidence: number;
  image_url: string;
  image_source: string;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderWithItems extends PurchaseOrder {
  items: POLineItem[];
}

// ─── Helpers ─────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

// ─── Purchase Orders ─────────────────────────────────────────

export async function createPurchaseOrder(data: {
  supplier_name: string;
  po_number?: string;
  pdf_filename?: string;
  status?: POStatus;
  raw_parsed_json?: string;
  notes?: string;
}): Promise<string> {
  const id = generateId();
  try {
    await env.DB.prepare(
      `INSERT INTO purchase_orders (id, supplier_name, po_number, pdf_filename, status, raw_parsed_json, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      data.supplier_name,
      data.po_number || '',
      data.pdf_filename || '',
      data.status || 'draft',
      data.raw_parsed_json || '',
      data.notes || '',
    ).run();
    return id;
  } catch (err) {
    console.error('PO create error:', err);
    throw err;
  }
}

export async function getPurchaseOrder(id: string): Promise<PurchaseOrderWithItems | null> {
  try {
    const po = await env.DB.prepare(
      'SELECT * FROM purchase_orders WHERE id = ?'
    ).bind(id).first<PurchaseOrder>();

    if (!po) return null;

    const { results: items } = await env.DB.prepare(
      'SELECT * FROM po_line_items WHERE po_id = ? ORDER BY line_number ASC'
    ).bind(id).all<POLineItem>();

    return { ...po, items: items || [] };
  } catch (err) {
    console.error('PO read error:', err);
    return null;
  }
}

export async function listPurchaseOrders(
  status?: POStatus,
  page = 1,
  limit = 25,
): Promise<{ orders: PurchaseOrder[]; total: number }> {
  const offset = (page - 1) * limit;

  try {
    let countQuery: string;
    let listQuery: string;
    const binds: unknown[] = [];

    if (status) {
      countQuery = 'SELECT COUNT(*) as total FROM purchase_orders WHERE status = ?';
      listQuery = 'SELECT * FROM purchase_orders WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
      binds.push(status);
    } else {
      countQuery = 'SELECT COUNT(*) as total FROM purchase_orders';
      listQuery = 'SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT ? OFFSET ?';
    }

    const countRow = await env.DB.prepare(countQuery)
      .bind(...(status ? [status] : []))
      .first<{ total: number }>();

    const { results } = await env.DB.prepare(listQuery)
      .bind(...(status ? [status, limit, offset] : [limit, offset]))
      .all<PurchaseOrder>();

    return {
      orders: results || [],
      total: countRow?.total || 0,
    };
  } catch (err) {
    console.error('PO list error:', err);
    return { orders: [], total: 0 };
  }
}

export async function updatePurchaseOrder(
  id: string,
  data: Partial<Pick<PurchaseOrder, 'supplier_name' | 'po_number' | 'status' | 'notes'>>,
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.supplier_name !== undefined) { fields.push('supplier_name = ?'); values.push(data.supplier_name); }
  if (data.po_number !== undefined) { fields.push('po_number = ?'); values.push(data.po_number); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  try {
    const result = await env.DB.prepare(
      `UPDATE purchase_orders SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
    return result.meta.changes > 0;
  } catch (err) {
    console.error('PO update error:', err);
    return false;
  }
}

export async function deletePurchaseOrder(id: string): Promise<boolean> {
  try {
    // Line items cascade-delete via FK
    const result = await env.DB.prepare(
      'DELETE FROM purchase_orders WHERE id = ?'
    ).bind(id).run();
    return result.meta.changes > 0;
  } catch (err) {
    console.error('PO delete error:', err);
    return false;
  }
}

// ─── Line Items ──────────────────────────────────────────────

export async function createLineItems(
  poId: string,
  items: Array<{
    product_name: string;
    sku?: string;
    quantity?: number;
    unit_cost?: number;
    retail_price?: number;
    description?: string;
    shopify_product_id?: string;
    shopify_variant_id?: string;
    match_status?: MatchStatus;
    match_confidence?: number;
    image_url?: string;
    image_source?: string;
  }>,
): Promise<POLineItem[]> {
  const created: POLineItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = generateId();

    try {
      await env.DB.prepare(
        `INSERT INTO po_line_items
         (id, po_id, line_number, product_name, sku, quantity, unit_cost, retail_price,
          description, shopify_product_id, shopify_variant_id, match_status, match_confidence,
          image_url, image_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        poId,
        i + 1,
        item.product_name,
        item.sku || '',
        item.quantity || 1,
        item.unit_cost || 0,
        item.retail_price || 0,
        item.description || '',
        item.shopify_product_id || '',
        item.shopify_variant_id || '',
        item.match_status || 'unmatched',
        item.match_confidence || 0,
        item.image_url || '',
        item.image_source || '',
      ).run();

      created.push({
        id,
        po_id: poId,
        line_number: i + 1,
        product_name: item.product_name,
        sku: item.sku || '',
        quantity: item.quantity || 1,
        unit_cost: item.unit_cost || 0,
        retail_price: item.retail_price || 0,
        description: item.description || '',
        shopify_product_id: item.shopify_product_id || '',
        shopify_variant_id: item.shopify_variant_id || '',
        match_status: (item.match_status || 'unmatched') as MatchStatus,
        match_confidence: item.match_confidence || 0,
        image_url: item.image_url || '',
        image_source: item.image_source || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Line item create error (${i}):`, err);
    }
  }

  return created;
}

export async function updateLineItem(
  id: string,
  data: Partial<Pick<POLineItem,
    'product_name' | 'sku' | 'quantity' | 'unit_cost' | 'retail_price' |
    'description' | 'shopify_product_id' | 'shopify_variant_id' |
    'match_status' | 'match_confidence' | 'image_url' | 'image_source'
  >>,
): Promise<boolean> {
  const fields: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, unknown> = { ...data };
  for (const [key, val] of Object.entries(fieldMap)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  try {
    const result = await env.DB.prepare(
      `UPDATE po_line_items SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
    return result.meta.changes > 0;
  } catch (err) {
    console.error('Line item update error:', err);
    return false;
  }
}

export async function getLineItem(id: string): Promise<POLineItem | null> {
  try {
    return await env.DB.prepare(
      'SELECT * FROM po_line_items WHERE id = ?'
    ).bind(id).first<POLineItem>();
  } catch (err) {
    console.error('Line item read error:', err);
    return null;
  }
}
