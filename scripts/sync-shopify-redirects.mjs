#!/usr/bin/env node
// Sync Shopify URL redirects so /products/{handle} on the Shopify domain
// 301s to the same handle on the custom domain.

const SHOP = "sunnyandranney.myshopify.com";
const CUSTOM_DOMAIN = "https://sunnyandranney.com";
const API_VERSION = "2025-01";

const PRUNE = process.argv.includes("--prune");
const BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

let TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!TOKEN && !(CLIENT_ID && CLIENT_SECRET)) {
  console.error(
    "ERROR: provide SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET."
  );
  process.exit(1);
}

async function exchangeClientCredentials() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

function buildHeaders() {
  return {
    "X-Shopify-Access-Token": TOKEN,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

const MIN_INTERVAL_MS = 500; // ~2 req/sec
let lastRequestAt = 0;

async function throttle() {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function shopifyFetch(url, init = {}, retries = 5) {
  await throttle();
  const res = await fetch(url, {
    ...init,
    headers: { ...buildHeaders(), ...(init.headers || {}) },
  });

  if (res.status === 429 && retries > 0) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") || "2");
    await new Promise((r) => setTimeout(r, Math.max(1000, retryAfter * 1000)));
    return shopifyFetch(url, init, retries - 1);
  }

  if (res.status >= 500 && retries > 0) {
    await new Promise((r) => setTimeout(r, 1000));
    return shopifyFetch(url, init, retries - 1);
  }

  return res;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function fetchAllProductHandles() {
  const handles = [];
  let url = `${BASE}/products.json?limit=250&fields=handle`;
  while (url) {
    const res = await shopifyFetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch products: ${res.status} ${text}`);
    }
    const data = await res.json();
    for (const p of data.products || []) {
      if (p.handle) handles.push(p.handle);
    }
    url = parseNextLink(res.headers.get("link") || res.headers.get("Link"));
  }
  return handles;
}

async function fetchAllRedirects() {
  const map = new Map(); // path -> { id, target }
  let url = `${BASE}/redirects.json?limit=250`;
  while (url) {
    const res = await shopifyFetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch redirects: ${res.status} ${text}`);
    }
    const data = await res.json();
    for (const r of data.redirects || []) {
      map.set(r.path, { id: r.id, target: r.target });
    }
    url = parseNextLink(res.headers.get("link") || res.headers.get("Link"));
  }
  return map;
}

async function createRedirect(path, target) {
  const res = await shopifyFetch(`${BASE}/redirects.json`, {
    method: "POST",
    body: JSON.stringify({ redirect: { path, target } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create failed for ${path}: ${res.status} ${text}`);
  }
}

async function updateRedirect(id, path, target) {
  const res = await shopifyFetch(`${BASE}/redirects/${id}.json`, {
    method: "PUT",
    body: JSON.stringify({ redirect: { id, path, target } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Update failed for ${path} (id ${id}): ${res.status} ${text}`);
  }
}

async function deleteRedirect(id, path) {
  const res = await shopifyFetch(`${BASE}/redirects/${id}.json`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delete failed for ${path} (id ${id}): ${res.status} ${text}`);
  }
}

async function main() {
  console.log(`Shop:           ${SHOP}`);
  console.log(`Custom domain:  ${CUSTOM_DOMAIN}`);
  console.log(`API version:    ${API_VERSION}`);
  console.log(`Prune stale:    ${PRUNE ? "yes" : "no (use --prune to delete)"}`);
  console.log("");

  if (!TOKEN) {
    console.log("Exchanging client credentials for access token...");
    TOKEN = await exchangeClientCredentials();
    console.log("  got 24h access token.");
  }

  console.log("Fetching product handles...");
  const handles = await fetchAllProductHandles();
  console.log(`  ${handles.length} products found.`);

  console.log("Fetching existing redirects...");
  const existing = await fetchAllRedirects();
  console.log(`  ${existing.size} redirects found.`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const desiredPaths = new Set();

  for (const handle of handles) {
    const path = `/products/${handle}`;
    const target = `${CUSTOM_DOMAIN}/products/${handle}`;
    desiredPaths.add(path);

    const current = existing.get(path);
    try {
      if (!current) {
        await createRedirect(path, target);
        created++;
        console.log(`  + created  ${path}`);
      } else if (current.target !== target) {
        await updateRedirect(current.id, path, target);
        updated++;
        console.log(`  ~ updated  ${path}  (was: ${current.target})`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.error(`  ! error    ${path}: ${err.message}`);
    }
  }

  const stale = [];
  for (const [path, info] of existing.entries()) {
    if (path.startsWith("/products/") && !desiredPaths.has(path)) {
      stale.push({ path, ...info });
    }
  }

  if (stale.length > 0) {
    console.log("");
    console.log(`Stale /products/* redirects (handle no longer in product list): ${stale.length}`);
    for (const s of stale) {
      if (PRUNE) {
        try {
          await deleteRedirect(s.id, s.path);
          console.log(`  - deleted  ${s.path}`);
        } catch (err) {
          errors++;
          console.error(`  ! error    delete ${s.path}: ${err.message}`);
        }
      } else {
        console.warn(`  ? stale    ${s.path} -> ${s.target}`);
      }
    }
  }

  console.log("");
  console.log("Summary:");
  console.log(`  created: ${created}`);
  console.log(`  updated: ${updated}`);
  console.log(`  skipped: ${skipped}`);
  console.log(`  stale:   ${stale.length}${PRUNE ? " (deleted)" : " (warned)"}`);
  console.log(`  errors:  ${errors}`);

  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
