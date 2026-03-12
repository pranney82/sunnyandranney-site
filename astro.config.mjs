import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sunnyandranney.com',
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile', // Optimize images at build time (sharp not available at CF runtime)
  }),
  integrations: [
    sitemap(),
  ],

  // Prefetch links on hover/focus for instant navigation
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'hover',
  },

  image: {
    domains: ['cdn.shopify.com'],
  },
  vite: {
    define: {
      'import.meta.env.PUBLIC_SHOPIFY_STORE_DOMAIN': JSON.stringify(process.env.PUBLIC_SHOPIFY_STORE_DOMAIN || 'sunnyandranney.myshopify.com'),
      'import.meta.env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN': JSON.stringify(process.env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN || ''),
    },
  },
});
