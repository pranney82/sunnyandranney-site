import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import { loadEnv } from 'vite';

const env = loadEnv(process.env.NODE_ENV || 'production', process.cwd(), '');

// Fetch product updatedAt map from Shopify at build time so sitemap <lastmod>
// reflects real content changes (not deploy time). Google uses lastmod to
// decide what to recrawl — stable values = better crawl budget.
async function fetchProductLastmod() {
  const domain = env.PUBLIC_SHOPIFY_STORE_DOMAIN;
  const token = env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN;
  if (!domain || !token) return new Map();
  const map = new Map();
  let cursor = null;
  try {
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`https://${domain}/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({
          query: `query($cursor: String) {
            products(first: 250, after: $cursor) {
              edges { cursor node { handle updatedAt } }
              pageInfo { hasNextPage }
            }
          }`,
          variables: { cursor },
        }),
      });
      const json = await res.json();
      const edges = json?.data?.products?.edges || [];
      for (const e of edges) map.set(e.node.handle, e.node.updatedAt);
      if (!json?.data?.products?.pageInfo?.hasNextPage) break;
      cursor = edges[edges.length - 1]?.cursor;
    }
  } catch (err) {
    console.warn('[sitemap] Failed to fetch product lastmod:', err?.message);
  }
  return map;
}

const productLastmod = await fetchProductLastmod();
console.log(`[sitemap] Loaded lastmod for ${productLastmod.size} products`);

const redirects = {
  '/events/': 'https://sunshineonaranneyday.com/events/golf/',
  '/deal-of-the-week/': '/shop/',
  '/about-us-every-purchase-supports-home-makeovers/': '/about/',
  '/showroom-inventory/': '/shop/',
  '/shop-online/': '/shop/',
  '/author/kbadmin/': '/',
  '/reset-password/': '/',
  '/home/': '/',
  '/about-us/': '/about/',
  '/about-us-every-purchase-supports-home-makeovers/1000/': '/about/',
};

const redirectPaths = Object.keys(redirects).map((p) => p.replace(/\/$/, ''));

export default defineConfig({
  site: 'https://sunnyandranney.com',
  output: 'static',
  trailingSlash: 'always',
  adapter: cloudflare(),
  server: { port: 4322 },
  integrations: [
    sitemap({
      filter: (page) => {
        const url = new URL(page);
        const path = url.pathname.replace(/\/$/, '');
        if (path.startsWith('/admin')) return false;
        return !redirectPaths.some((r) => path.startsWith(r));
      },
      serialize(item) {
        const url = new URL(item.url);
        const path = url.pathname;
        // Product pages: use Shopify updatedAt so Google recrawls on real change
        const productMatch = path.match(/^\/shop\/([^/]+)\/?$/);
        if (productMatch) {
          const handle = decodeURIComponent(productMatch[1]);
          const updatedAt = productLastmod.get(handle);
          if (updatedAt) item.lastmod = updatedAt;
          item.changefreq = 'weekly';
          item.priority = 0.8;
          return item;
        }
        // Homepage + shop index: change often
        if (path === '/' || path === '/shop/') {
          item.changefreq = 'daily';
          item.priority = 1.0;
          return item;
        }
        // Static pages: rarely change
        item.changefreq = 'monthly';
        item.priority = 0.5;
        return item;
      },
    }),
  ],

  redirects,

  // Strip whitespace from HTML output
  compressHTML: true,

  // Inline all CSS into HTML — eliminates render-blocking stylesheet requests (~160ms savings)
  build: {
    inlineStylesheets: 'always',
  },

  // Prefetch on hover — avoids bandwidth competition with LCP on slow connections
  prefetch: {
    defaultStrategy: 'hover',
  },

});
