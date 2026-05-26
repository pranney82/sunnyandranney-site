export interface Env {
  DB: D1Database;
  SHOPIFY_API_VERSION: string;
  SHOPIFY_STORE_DOMAIN: string;
  SHOPIFY_APP_CLIENT_ID: string;
  SHOPIFY_ADMIN_TOKEN: string; // fallback / legacy; OAuth-captured token in D1 takes precedence
  SHOPIFY_WEBHOOK_SECRET: string; // also used as OAuth client_secret (same value for a Shopify app)
}
