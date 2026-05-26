-- Webhook idempotency tracking for the loyalty system.
-- Shopify recommends deduping deliveries via X-Shopify-Webhook-Id; this table holds those IDs
-- for at least 48h (the retry window).
CREATE TABLE loyalty_webhook_log (
  webhook_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL DEFAULT 'processed',
  error_message TEXT
);

CREATE INDEX idx_loyalty_webhook_log_received ON loyalty_webhook_log(received_at);
