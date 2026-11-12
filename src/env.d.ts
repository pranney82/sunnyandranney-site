/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

// Augment the auto-generated Env with secret env vars
// (set via CF dashboard or `wrangler secret`, not in wrangler.toml)
declare namespace Cloudflare {
  interface Env {
    SYNC_SECRET?: string;
    CF_DEPLOY_HOOK_URL?: string;
    DEPLOY_COORDINATOR: DurableObjectNamespace;
    KIT_API_KEY?: string;
    GOOGLE_PLACES_API_KEY?: string;
    GOOGLE_PLACE_ID?: string;
    SHOPIFY_ADMIN_TOKEN?: string;
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
    ADMIN_MANAGER_EMAILS?: string;
    ADMIN_KIOSK_EMAILS?: string;
    ADMIN_KIOSK_SERVICE_TOKENS?: string;
    ADMIN_OWNER_EMAILS?: string;
    ADMIN_DEV_EMAIL?: string;
    GUSTO_ENV?: string;
    GUSTO_CLIENT_ID?: string;
    GUSTO_CLIENT_SECRET?: string;
    GUSTO_MCP_CLIENT_ID?: string;
    GUSTO_MCP_CLIENT_SECRET?: string;
    GUSTO_TOKEN_KEY?: string;
    /** The Medusa backend the buying and warehouse pages call, and its secret admin key. */
    MEDUSA_BACKEND_URL?: string;
    MEDUSA_ADMIN_KEY?: string;
    /** sent.dm, which texts staff their schedule. */
    SENT_DM_API_KEY?: string;
    /** A stand-in sent.dm for local tests. Never set in production. */
    SENT_DM_API_BASE?: string;
    /** "1" sends with sent.dm's sandbox flag: checked, never delivered. */
    SENT_DM_SANDBOX?: string;
  }
}

type Runtime = import('@astrojs/cloudflare').Runtime<Cloudflare.Env>;

declare namespace App {
  interface Locals extends Runtime {
    /** Set by src/middleware.ts on /admin and /api/admin routes only. */
    admin?: import('@/lib/admin-auth').AdminIdentity;
  }
}
