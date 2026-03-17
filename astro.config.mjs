import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sunnyandranney-site.pages.dev',
  output: 'static',
  adapter: cloudflare(),
  server: { port: 4322 },
  integrations: [
    sitemap(),
  ],

  // Strip whitespace from HTML output
  compressHTML: true,

  // Prefetch ALL internal links when they enter the viewport — pages load before the click
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },

});
