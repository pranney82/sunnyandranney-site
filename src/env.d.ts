/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

// Augment the auto-generated Env with secret env vars
// (set via CF dashboard or `wrangler secret`, not in wrangler.toml)
declare namespace Cloudflare {
  interface Env {
    SYNC_SECRET?: string;
    CF_DEPLOY_HOOK_URL?: string;
    CC_API_TOKEN?: string;
    GOOGLE_PLACES_API_KEY?: string;
    GOOGLE_PLACE_ID?: string;
    ANTHROPIC_API_KEY: string;
    SHOPIFY_ADMIN_TOKEN?: string;
    CF_IMAGES_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
  }
}
