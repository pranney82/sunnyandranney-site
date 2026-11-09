/** Shared by the buying, receiving and vendor pages: their shapes and how they read. */

export interface PurchaseOrderSummary {
  id: string;
  display_number: string;
  vendor_id: string;
  vendor_name: string;
  vendor_code: string | null;
  status: PoStatus;
  ordered_at: string | null;
  expected_on: string | null;
  vendor_confirmation: string | null;
  confirmed_on: string | null;
  created_at: string;
  line_count: number;
  units: number;
  received: number;
  total_cents: number;
}

export type PoStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled';

export interface PoLine {
  id: string;
  position: number;
  variant_id: string;
  vendor_sku: string | null;
  title: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_refused: number;
  quantity_cancelled: number;
  unit_cost_cents: number;
  expected_on: string | null;
  outstanding: number;
  thumbnail: string | null;
  barcode: string | null;
  price_cents: number | null;
}

export interface PurchaseOrder extends Omit<PurchaseOrderSummary, 'vendor_name' | 'vendor_code' | 'line_count' | 'units' | 'received' | 'total_cents'> {
  vendor: { id: string; name: string; code: string | null };
  location_id: string;
  freight_estimate_cents: number;
  terms_days: number | null;
  notes: string | null;
  lines: PoLine[];
  receipts: { id: string; received_at: string; received_by: string; freight_cents: number; lines: { accepted: number; damaged: number; refused: number }[] }[];
  invoices: { id: string; number: string; invoice_date: string; total_cents: number }[];
}

export interface Vendor {
  id: string;
  name: string;
  code: string | null;
  aliases: string[];
  kind: 'wholesale' | 'retail' | 'house';
  active: boolean;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  account_number: string | null;
  terms_days: number | null;
  lead_days: number | null;
  minimum_order_cents: number | null;
  notes: string | null;
}

export const STATUS: Record<PoStatus, { label: string; badge: string }> = {
  draft: { label: 'Draft', badge: 'badge' },
  ordered: { label: 'Ordered', badge: 'badge badge-sent' },
  partially_received: { label: 'Partly received', badge: 'badge badge-pending' },
  received: { label: 'Received', badge: 'badge badge-approved' },
  cancelled: { label: 'Cancelled', badge: 'badge badge-rejected' },
};

export function money(cents: number | null | undefined, opts: { whole?: boolean } = {}): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  if (opts.whole) return `${sign}$${Math.round(abs / 100).toLocaleString('en-US')}`;
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** A calendar day as the store says it: "Tue, Nov 10". */
export function day(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

/** Days from today to a YYYY-MM-DD day, in the store's time zone. Negative is late. */
export function daysUntil(value: string | null | undefined, now = new Date()): number | null {
  if (!value) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  return Math.round((Date.parse(`${value.slice(0, 10)}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
}

export function whenLabel(expected: string | null): { text: string; late: boolean } {
  const n = daysUntil(expected);
  if (n === null) return { text: 'No date yet', late: false };
  if (n < 0) return { text: `${-n} day${n === -1 ? '' : 's'} late`, late: true };
  if (n === 0) return { text: 'Due today', late: false };
  if (n === 1) return { text: 'Due tomorrow', late: false };
  return { text: `Due ${day(expected)}`, late: false };
}

/**
 * A register sale line waiting for a cost: a special order the store hasn't bought
 * yet or hasn't received, or something sold with no cost. From
 * `purchasing/costs-to-match` in Medusa.
 */
export interface AwaitingCost {
  sale_line_id: string;
  /** client_sale_id:line_id, what a PO line bought for it names. */
  for_sale_line: string;
  receipt_number: string;
  sold_at: string;
  title: string;
  sku: string | null;
  variant_id: string | null;
  quantity: number;
  unit_price_cents: number;
  fulfillment_method: string;
  promise_date: string | null;
  costed: number;
  on_order: number;
  needs_po: number;
  needs_cost: number;
  vendor_id: string | null;
  po_lines: { purchase_order_id: string; number: number; status: string; line_id: string; quantity: number; received: number; unit_cost_cents: number }[];
}

/** PO-0012, as the admin shows a PO number. */
export const poNumber = (n: number) => `PO-${String(n).padStart(4, '0')}`;
