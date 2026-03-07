# Sunny & Ranney — Website

A blazing-fast, SEO-optimized website for [Sunny & Ranney](https://sunnyandranney.com), built with Astro and deployed to Cloudflare Pages.

## Tech Stack

- **Framework:** [Astro](https://astro.build) — ships zero JS by default, perfect Lighthouse scores
- **Hosting:** [Cloudflare Pages](https://pages.cloudflare.com) — edge-deployed globally, ~200ms page loads
- **E-commerce:** [Shopify Storefront API](https://shopify.dev/docs/api/storefront) — products, cart, and checkout
- **SEO:** JSON-LD structured data, Open Graph, semantic HTML, AI-crawler friendly
- **Design:** Custom CSS design system — warm editorial aesthetic with Cormorant Garamond + DM Sans

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Shopify Setup

### 1. Create a Storefront API Token

1. Go to **Shopify Admin** → **Settings** → **Apps and sales channels**
2. Click **Develop apps** → **Create an app**
3. Name it (e.g., "Sunny & Ranney Website")
4. Under **Configuration**, enable **Storefront API access scopes:**
   - `unauthenticated_read_products`
   - `unauthenticated_read_product_listings`
   - `unauthenticated_write_checkouts`
   - `unauthenticated_read_checkouts`
5. Click **Install app** and copy the **Storefront API access token**

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:
```
PUBLIC_SHOPIFY_STORE_DOMAIN=sunnyandranney.myshopify.com
PUBLIC_SHOPIFY_STOREFRONT_TOKEN=your_token_here
```

## Deploy to Cloudflare Pages

### Via Git (Recommended)

1. Push this repo to GitHub/GitLab
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Pages** → **Create a project**
3. Connect your Git repo
4. **Build settings:**
   - Framework preset: `Astro`
   - Build command: `npm run build`
   - Build output directory: `dist`
5. **Environment variables:** Add your Shopify token
6. Deploy!

### Custom Domain

1. In Cloudflare Pages → your project → **Custom domains**
2. Add `sunnyandranney.com`
3. Update your domain's nameservers to Cloudflare (if not already)

## Project Structure

```
src/
├── components/
│   ├── Nav.astro          # Navigation with mobile menu
│   ├── Footer.astro       # Footer with charity bar
│   └── SEO.astro          # SEO meta tags + JSON-LD structured data
├── layouts/
│   └── Base.astro         # Base HTML layout
├── lib/
│   └── shopify.ts         # Shopify Storefront API client
├── pages/
│   ├── index.astro        # Homepage
│   ├── about.astro        # Our Story
│   ├── charity.astro      # Our Charity / Mission
│   └── shop/
│       ├── index.astro    # Product listing with filters
│       └── [handle].astro # Dynamic product detail pages
├── styles/
│   └── global.css         # Design system + global styles
public/
├── favicon.svg
└── robots.txt             # SEO + AI crawler rules
```

## Adding Your Content

### Images
Replace the placeholder `<div>` elements with actual `<img>` tags throughout the pages:
- **Hero image:** A wide showroom/lifestyle photo (2400×1600px)
- **Story images:** Store interior, charity events, founders
- **Charity page:** Before/after room transformation photos
- **Product images:** Handled automatically via Shopify CDN

### Logo
Replace the text logo in `Nav.astro` and `Footer.astro` with your actual logo SVG or image.

### Store Address
Update the full address in `SEO.astro` (structured data), `Footer.astro`, and `index.astro` (visit section).

### Google Maps
Replace the map placeholder in `index.astro` with a Google Maps embed or Mapbox map.

## SEO Features

- **JSON-LD Structured Data:** FurnitureStore, Organization, Product schemas
- **Open Graph:** Full social sharing metadata on every page
- **Semantic HTML5:** Proper heading hierarchy, landmarks, ARIA labels
- **AI-Friendly:** robots.txt allows GPTBot, ClaudeBot, PerplexityBot
- **Auto-generated Sitemap:** Via `@astrojs/sitemap`
- **Performance:** Static HTML, zero JS by default, optimized images via Shopify CDN

## Performance

Expected Lighthouse scores:
- Performance: **100**
- Accessibility: **95+**
- Best Practices: **100**
- SEO: **100**

## License

Proprietary — Sunny & Ranney / Sunshine on a Ranney Day
