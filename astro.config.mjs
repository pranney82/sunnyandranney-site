import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sunnyandranney.com',
  output: 'static',
  adapter: cloudflare(),
  integrations: [
    sitemap(),
  ],

  // Prefetch links on hover/focus for instant navigation
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'hover',
  },
});
