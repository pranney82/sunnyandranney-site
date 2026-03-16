import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sunnyandranney-site.pages.dev',
  output: 'static',
  adapter: cloudflare(),
  integrations: [
    sitemap(),
  ],

  // Prefetch links when they enter the viewport — pages are ready before the click
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'viewport',
  },

});
