import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

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
