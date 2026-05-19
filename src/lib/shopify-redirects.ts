// Shopify URL redirect management for `/products/{handle}` → custom storefront.
// Used by the products/create + products/update webhook handler so new and
// renamed products get a Shopify-side 301 without a manual `npm run sync-redirects`.

const API_VERSION = '2025-01';
const STOREFRONT_ORIGIN = 'https://sunnyandranney.com';

export type EnsureRedirectResult = {
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  error?: string;
};

function buildHeaders(adminToken: string) {
  return {
    'X-Shopify-Access-Token': adminToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function findRedirectByPath(
  domain: string,
  adminToken: string,
  path: string,
): Promise<{ id: number; target: string } | null> {
  const url = `https://${domain}/admin/api/${API_VERSION}/redirects.json?path=${encodeURIComponent(path)}&limit=1`;
  const res = await fetch(url, { headers: buildHeaders(adminToken) });
  if (!res.ok) throw new Error(`lookup failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { redirects?: Array<{ id: number; path: string; target: string }> };
  const match = data.redirects?.find((r) => r.path === path);
  return match ? { id: match.id, target: match.target } : null;
}

async function createRedirect(domain: string, adminToken: string, path: string, target: string) {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/redirects.json`, {
    method: 'POST',
    headers: buildHeaders(adminToken),
    body: JSON.stringify({ redirect: { path, target } }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
}

async function updateRedirect(domain: string, adminToken: string, id: number, path: string, target: string) {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/redirects/${id}.json`, {
    method: 'PUT',
    headers: buildHeaders(adminToken),
    body: JSON.stringify({ redirect: { id, path, target } }),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
}

export async function ensureProductRedirect(
  domain: string,
  adminToken: string,
  handle: string,
): Promise<EnsureRedirectResult> {
  if (!handle) return { action: 'skipped', error: 'missing handle' };
  const path = `/products/${handle}`;
  const target = `${STOREFRONT_ORIGIN}/shop/${handle}/`;

  try {
    const existing = await findRedirectByPath(domain, adminToken, path);
    if (!existing) {
      await createRedirect(domain, adminToken, path, target);
      return { action: 'created' };
    }
    if (existing.target !== target) {
      await updateRedirect(domain, adminToken, existing.id, path, target);
      return { action: 'updated' };
    }
    return { action: 'unchanged' };
  } catch (err: any) {
    return { action: 'skipped', error: err?.message || 'unknown' };
  }
}
