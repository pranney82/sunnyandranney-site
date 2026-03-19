import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://sunnyandranney.com',
  output: 'static',
  adapter: cloudflare(),
  server: { port: 4322 },
  integrations: [
    sitemap(),
  ],

  // Strip whitespace from HTML output
  compressHTML: true,

  // Inline all CSS into HTML — eliminates render-blocking stylesheet requests (~160ms savings)
  build: {
    inlineStylesheets: 'always',
  },

  // Prefetch links marked with data-astro-prefetch when they enter the viewport
  prefetch: {
    defaultStrategy: 'viewport',
  },

});
