-- Maps Shopify inventory_item_id to product handle
-- Needed because inventory_levels/update webhooks only send inventory_item_id
CREATE TABLE IF NOT EXISTS inventory_item_map (
  inventory_item_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_item_map_handle ON inventory_item_map(handle);
