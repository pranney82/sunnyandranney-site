-- Purchase orders (supplier invoices parsed from PDF)
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  supplier_name TEXT NOT NULL DEFAULT '',
  po_number TEXT DEFAULT '',
  pdf_filename TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  raw_parsed_json TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_created ON purchase_orders(created_at DESC);

-- Line items within a PO
CREATE TABLE IF NOT EXISTS po_line_items (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0,
  retail_price REAL DEFAULT 0,
  description TEXT DEFAULT '',
  shopify_product_id TEXT DEFAULT '',
  shopify_variant_id TEXT DEFAULT '',
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  match_confidence REAL DEFAULT 0,
  image_url TEXT DEFAULT '',
  image_source TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_line_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_status ON po_line_items(match_status);
