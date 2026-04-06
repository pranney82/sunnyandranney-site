-- Product availability: fast lookups for Staci chat, updated by Shopify webhooks
-- Separate table avoids JSON blob read-modify-write race conditions
CREATE TABLE IF NOT EXISTS product_availability (
  handle TEXT PRIMARY KEY,
  available INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index not needed on handle (already PRIMARY KEY), but add one for batch queries
CREATE INDEX IF NOT EXISTS idx_product_availability_updated ON product_availability(updated_at);
