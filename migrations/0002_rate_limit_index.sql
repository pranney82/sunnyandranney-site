-- Index for rate_limits cleanup queries
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
