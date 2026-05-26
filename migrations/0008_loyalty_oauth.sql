-- OAuth state nonce storage (CSRF protection during install handshake).
-- Rows are short-lived: created on /auth/install, consumed on /auth/callback.
CREATE TABLE loyalty_oauth_state (
  state TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Captured Admin API access tokens from completed OAuth installs.
-- One row per shop. The worker reads the latest token here to authenticate Admin API calls.
CREATE TABLE loyalty_oauth_tokens (
  shop_domain TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  scopes TEXT NOT NULL,
  installed_at INTEGER NOT NULL DEFAULT (unixepoch())
);
