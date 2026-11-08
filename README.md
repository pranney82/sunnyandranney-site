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

## Staff admin (`/admin`)

Employees clock in on the store tablet, a manager reviews and approves hours,
and approved hours go to Gusto once per pay period. Gusto stays the payroll
system. It does not keep the time clock.

Login is [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/),
using emailed one-time codes. Employees have no accounts: they sign in to the
clock with a PIN, on a tablet logged in with the kiosk email. Without these
Cloudflare Pages variables, `/admin` denies everyone:

| Variable | Value |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | `soard.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | The Access application's audience tag |
| `ADMIN_MANAGER_EMAILS` | Comma-separated manager logins |
| `ADMIN_KIOSK_EMAILS` | The tablet's login. It can only reach the clock |

The admin lives at **https://admin.sunnyandranney.com**. The store's own DNS
records (`sunnyandranney.com`, `www`) are DNS-only, so Access can't guard them;
`admin` is a proxied CNAME to the Pages project, and the Access application
"Sunny & Ranney Admin" covers that whole host, plus `/admin*` and `/api/admin*`
on the `.pages.dev` hosts. A zone redirect rule sends `admin.sunnyandranney.com/`
to `/admin/`, because the home page is prebuilt and Pages serves it without
running any code. `src/lib/admin-host.mjs` does the same for server-rendered
pages on the admin host, and sends admin pages asked for on the store's
addresses there. The
app also verifies the Access token itself, so an address Access misses still
denies everyone. Sessions last a month (policy "Sunny & Ranney Admin
managers").

### Gusto connection

**Who counts as store staff.** Gusto holds the store and the charity as one
company, Sunshine on a Ranney Day Incorporated. Its **Sunny & Ranney**
department is the store. Every employee sync copies each person's department and
whether they've left, sets store staff from the department, puts people joining
the store on the time clock and takes people leaving the store or the company
off it. Other clock choices a manager makes stay. People who leave stay store
staff, so their past pay stays on Payroll, but Staff hides them unless "Show
all" is on.

An owner connects Gusto once at `/admin/gusto/`. After that, Staff and Payroll
read Gusto when they open. There are two routes, and the MCP settings win if both
are present.

**Through Gusto's MCP server.** This is Gusto's route for a customer connecting
their own company, and it needs no partner approval. **Send to Gusto** adds each
approved shift to Gusto's time tracking (`record_time`), then sets each person's
regular and overtime hours for the period on the draft payroll (`update_payroll`).
Gusto replaces hours rather than adding them, so sending again changes nothing.
Someone then checks the draft in Gusto and submits payroll; the admin can't run
or submit payroll. The page names store staff whose draft has hours with no
approved shifts behind them, such as Gusto's default hours. Gusto's own clock
stays on, so staff must use only one clock for a pay period. Send to Gusto
refuses a period where Gusto already holds hours it didn't send for anyone being
sent.

Gusto has no permission for either write alone. Its Write **Team data** box is
the only one that adds time sheets, and it also grants editing employees,
contractors and the company signatory. Its Write **Payment data** box is the only
one that edits draft payrolls, and it also grants changing pay rates. Peter
accepted both on 2026-11-07. The client calls no write tool but those two, each
through a method that sends only shift times or hour lines. Without Payment data,
someone presses Sync hours to payroll in Gusto. With neither, the connection is
read only, and **Hours for Gusto** adds up approved hours per person for typing
in by hand.

Gusto's MCP docs only describe AI clients, and its terms cover linking to an LLM
account. Get Gusto's written OK, covering adding hours as well as reading, before
connecting the real company.

Gusto ignores the requested permissions and ticks every box on its sign-in screen.
**Under Write permissions keep only Team data and Payment data** (Run payroll must
be off), and untick bank, tax and benefits under Read permissions. The admin refuses any other write permission,
apart from six extras Gusto adds to every sign-in, listed in
`src/lib/gusto/mcp-oauth.mjs`. The client can only call the tools listed in
`src/lib/gusto/mcp-client.mjs`.

Tested on the demo company on 2026-11-07, with one gap: the demo still had the
old partner app connected as its time tracker, so hours went through it rather
than Gusto's own time tracking, which the real company uses.

**Disconnecting takes two steps.** Gusto's MCP server refuses to let this site
cancel a sign-in (403 `unauthorized_client`; the token belongs to Gusto's own MCP
app). So the admin's Disconnect only deletes the site's copy, and Gusto keeps
honoring it until an owner, in Gusto, opens App directory, then View connected
apps, then Manage on Gusto MCP, and chooses Disconnect app. The admin page says this after
every Disconnect. Gusto's link was tested on the demo company: the old sign-in
stopped working right away, and the admin switched to Reconnect by itself. A
sign-in the admin refuses (write access kept, or no company) is left behind at
Gusto the same way, and the page says so.

```sh
node scripts/gusto-mcp-register.mjs demo http://localhost:8789
node scripts/gusto-mcp-register.mjs production https://admin.sunnyandranney.com
```

The first saves to `.dev.vars`, and the second to `.dev.vars.production`. Neither
prints the secret.

**Partner API.** The `Store Payroll Data` app on
[dev.gusto.com](https://dev.gusto.com), in the Time Tracking category, adds
**Send to Gusto**, which puts approved hours on the draft payroll. Production keys
need Gusto's pre-approval, security review and QA, and Gusto doesn't accept a
customer connecting only its own company. This app turns off Gusto's own time
tracking when it connects. On the demo company it also turned off time-off
requests and declined any that were open.

| Setting | What it is |
|---|---|
| `ADMIN_OWNER_EMAILS` | Logins allowed to connect or disconnect Gusto. Must also be managers |
| `GUSTO_ENV` | `demo` or `production`. Anything else turns the connection off |
| `GUSTO_TOKEN_KEY` | `openssl rand -base64 32`. Encrypts tokens in D1. Store it as a secret. Changing it means reconnecting |
| `GUSTO_MCP_CLIENT_ID` | MCP route. From the register script |
| `GUSTO_MCP_CLIENT_SECRET` | MCP route. Store it as a secret |
| `GUSTO_CLIENT_ID` | Partner API route. From the app's page on dev.gusto.com |
| `GUSTO_CLIENT_SECRET` | Partner API route. Store it as a secret |

Gusto's API doesn't return its own clock-ins, so past shift-by-shift history
still comes from the one-time `history` import below, before you connect.

### Each pay period

With the app connected, use **Send to Gusto** on the Hours page. Without it:

Needs the [Gusto CLI](https://github.com/Gusto/gusto-cli), `gusto auth login`,
and `wrangler login`. Commands use the local database unless given `--remote`.

```sh
npm run gusto -- employees --remote                 # link staff to Gusto
npm run gusto -- push --remote                      # preview, sends nothing
npm run gusto -- push --remote --confirm            # send hours, sync the draft payroll
```

Then check the hours on the draft payroll in Gusto and run payroll there as usual.

To import past hours and pay, which are read-only and can never be pushed:

```sh
npm run gusto -- history --from 2025-01-01 --to 2026-11-05 --remote
npm run gusto -- pay --from 2025-01-01 --to 2026-11-05 --remote
```

Managers only see people marked **Store staff** on the Staff page, so mark them
before importing pay. The import saves gross pay and hours for those people.
Net pay, taxes and deductions stay in Gusto. The site can't reach Gusto itself,
so the Payroll page shows what was last imported: run `pay` after each payroll.

If a push stops without a clear answer from Gusto, the next one refuses to run
until you check Gusto and use `resolve`, so a shift can't be sent twice. See the
top of `scripts/gusto-hours.mjs`.

Overtime is calculated per the workweek in `src/lib/time-clock/hours.mjs`, which
must match the workweek set in Gusto.

