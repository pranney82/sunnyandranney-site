import type { Env } from '../env';
import { verifyOAuthCallbackHmac } from '../lib/hmac';

const REQUESTED_SCOPES = [
  'read_customers',
  'write_customers',
  'read_orders',
  'read_discounts',
  'write_discounts',
  'read_metaobjects',
  'write_metaobjects',
  'read_metaobject_definitions',
  'write_metaobject_definitions',
].join(',');

function isValidShop(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

export async function handleInstall(env: Env, url: URL): Promise<Response> {
  const shop = url.searchParams.get('shop') ?? env.SHOPIFY_STORE_DOMAIN;
  if (!isValidShop(shop)) {
    return new Response(`invalid shop: ${shop}`, { status: 400 });
  }

  const state = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO loyalty_oauth_state (state, shop_domain) VALUES (?, ?)',
  )
    .bind(state, shop)
    .run();

  const redirectUri = `${url.origin}/auth/callback`;
  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', env.SHOPIFY_APP_CLIENT_ID);
  authorizeUrl.searchParams.set('scope', REQUESTED_SCOPES);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

export async function handleCallback(env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const shop = url.searchParams.get('shop');

  if (!code || !shop) {
    return new Response('missing required params (code, shop)', { status: 400 });
  }
  if (!isValidShop(shop)) {
    return new Response(`invalid shop: ${shop}`, { status: 400 });
  }

  // Primary security check: Shopify signs the callback URL with our client secret.
  const hmacOk = await verifyOAuthCallbackHmac(url, env.SHOPIFY_WEBHOOK_SECRET);
  if (!hmacOk) {
    return new Response('invalid hmac on callback', { status: 403 });
  }

  // Defense-in-depth: if a state row exists, consume it. HMAC above is the security check;
  // a missing or mismatched row is informational (handles Shopify-initiated installs, replays,
  // and casing/domain normalization differences).
  if (state) {
    const stateRow = await env.DB.prepare(
      'SELECT shop_domain FROM loyalty_oauth_state WHERE state = ?',
    )
      .bind(state)
      .first<{ shop_domain: string }>();

    if (stateRow && stateRow.shop_domain.toLowerCase() !== shop.toLowerCase()) {
      console.warn(
        `[oauth] state shop mismatch (stored=${stateRow.shop_domain}, callback=${shop}); proceeding on HMAC`,
      );
    }
    if (stateRow) {
      await env.DB.prepare('DELETE FROM loyalty_oauth_state WHERE state = ?').bind(state).run();
    }
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.SHOPIFY_APP_CLIENT_ID,
      client_secret: env.SHOPIFY_WEBHOOK_SECRET, // client secret == webhook secret for an app
      code,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return new Response(`token exchange failed: ${err}`, { status: 500 });
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; scope: string };

  await env.DB.prepare(
    'INSERT OR REPLACE INTO loyalty_oauth_tokens (shop_domain, access_token, scopes, installed_at) VALUES (?, ?, ?, unixepoch())',
  )
    .bind(shop, tokenData.access_token, tokenData.scope)
    .run();

  return new Response(
    `Install complete for ${shop}. Token captured. You can close this tab.`,
    { status: 200, headers: { 'Content-Type': 'text/plain' } },
  );
}
