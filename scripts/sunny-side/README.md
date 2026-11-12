# The Sunny Side (the store's weekly email)

`build.mjs` turns one weekly brief into the Kit-ready email, in the team's chosen design: B, "Sunny" (bold color blocks and edge-to-edge photos). `verify.mjs` holds every build to the standard below.

The email itself is `src/lib/sunny-side/email.mjs`. It's the same code the admin uses for the live preview on the weekly special page, so that preview is the email.

```
node scripts/sunny-side/build.mjs      # every brief -> out/, every stress test -> out/tests/
node scripts/sunny-side/verify.mjs     # 6 renders per email; exits 1 on any failure
```

## Each week

1. Pick 4 to 9 products for the photo wall, and get a photo for the top and one for the story when there is a story. Mike, the photographer, shoots the top and story photos; the wall uses each product's own store photo unless the brief picks another.
2. Staci sets the week's special at admin.sunnyandranney.com/admin/special/, and sends any events.
3. Fill a brief in `briefs/` with `"sale": "admin"`, then build, verify, and test-send to Peter's inbox through Cloudflare Email Sending. Staci and Holly approve the test, then it goes into Kit.

`"sale": "admin"` makes the build read the special Staci saved for the brief's `send_date` from the store's D1 database, using wrangler. If she hasn't saved one yet, that brief isn't built and the build says so. `--local` reads the local dev database instead (`node scripts/sunny-side/build.mjs --local brief.json`). The sale's numbers and terms are Staci's to set there; a brief never asks anyone else for them.

The build tries every brief, so one waiting on the admin doesn't hold up the rest, then lists any it couldn't build and exits 1. A brief that fails, or is gone, leaves no old email in `out/`, so `verify.mjs` can't pass a stale one. Each built email prints its subject as it will go out.

## The brief

Every field below is used. Nothing else is read.

- `send_date` (YYYY-MM-DD): event dates before it drop out, and it names the UTM campaign (`sunny-side-<send_date>`).
- `subject`, `preheader`. Since the offer comes from the admin, they name it without typing its numbers: `{offer}` becomes the offer in a line ("Spend $250, save 10%. Spend $1,000, save 20%.", the first and last tier, or "20% off everything.") and `{upto}` its biggest percent ("20%"). Anything either line says about the discount is checked against the offer, and a mismatch stops the build: every percent off must be one the sale gives, "up to" must be its biggest, and with tiers every dollar amount must be a tier, with that tier's own percent beside it ("100% of our profits" is a share, so it's left alone).
- `sale`: `"admin"` (above) for a real week, or the offer itself (the stress tests). The offer has `name` (the small label), `cta`, `url` (a site path), optional `details` (fine print, shown under the button), and by `kind`:
  - `tiers`: `headline`, `tiers` as `[[spend, percent], ...]`, 2 to 4 of them. Four tiers, or any tier from $10,000 up, write every amount short, like `$2.5k+`.
  - `percent`: `percent`, `what` (e.g. `"everything."`)
  - `headline`: `headline`
- `hero`: `src`, `alt`.
- `wall`: `label`, `headline`, optional `more` (the site path "Shop all" goes to; the whole shop by default, so it matches what the products are), and `photos` (4 to 9 products). Say only what's true of the picks: "Just landed" needs products that really are new. Each product is:
  - `url`: its page on sunnyandranney.com/shop/, where it can be bought;
  - optional `src`: a photo to use instead of the product's first store photo;
  - optional `name`: a short name, needed only when the store's name runs over 28 characters (the build says when).

  The build reads each product's name, price and photos from its page, the same structured data search engines read, and its stock from the shop page's own count (the number the site's filters use; a product page says "InStock" even at zero when the store sells on order). A product with none in stock, a name too long for a tile, a product with only PNG photos, or a page it can't read stops the build, with every problem listed at once. A real brief can't give its own `price`; only the stress tests in `tests/` do, so they run offline. Each tile is one link: the photo, then the name in bold, then the price. The photo needs no alt, because the name under it is in the same link.
- `story` (optional): `label`, `headline`, `body`, `photo` (`src`, `alt`), `cta` as `[text, site path]`.
- `events` (optional list): `title`, `time` (the series' hours), optional `label` (default "Coming up"), and `items`. The line under the title is written from the dates still ahead ("Saturdays, 11am–2pm, Nov 21 to Dec 19"), so it never goes stale. With one date left there's no line, because the card says it all. Only events on different weekdays take a `when`, saying what's on ("Late shopping nights and Saturday crafts for kids"); the dates are added after it. A `when` that names a date, or a `when` on a one-weekday series, stops the build. Each item has:
  - `date` (YYYY-MM-DD; month, day and weekday come from it), `what`;
  - optional `note`, `time` (only when it differs from the series), and `greg` (Greg's photo when that date is the spotlight).
  - Optional `calendar` (weekly series only): `title`, `start` and `end` (HH:MM), `intro` (the first line of the calendar notes) and `ics` (the series' file). The Google link starts at the next date still ahead and lists only the dates left, so no one adds one that has passed.
- `mission`: the charity section.
  - `photo` (`src`, `alt`): the latest reveal.
  - `caption`: who's in it, like "Remi and Nico, ages 14 and 12, in their new bathroom."
  - `story`: two sentences on what changed for them.
  - `cta`, `url`: the button and their page on sunshineonaranneyday.com.
  - `impact`: `"live"` reads the charity's room makeovers and children served from its brand page (sunshineonaranneyday.com/branding/) at build time. If it can't, the build stops rather than printing old numbers. The stress tests use fixed numbers.

Photo `src` is either a full image URL or `cf:<id>` for Cloudflare Images, which crops around the subject. Shopify photos must be JPEG, because Shopify can't shrink PNGs.

`tests/` holds stress-test briefs: quiet week, four tiers, $10,000+ tiers, nine photos, events over, mixed weekdays. On their own they cover every photo-wall layout (4 to 9 photos), every tier count and all three sale kinds, so the standard is held even in a week whose brief is still waiting on the admin. They are built and verified with every run.

## The weekly special in the admin

`/admin/special/` is for managers. Staci picks this Tuesday's email or one of the next three, then picks one of three kinds of special and fills in only what that kind needs:
- spend more, save more: 2 to 4 tiers;
- percent off;
- a headline instead.

A discount (the first two) can't be saved without its terms: where it applies (in the showroom and online, in the showroom only, or online only) and its last day. The fine print under the button says them first ("In the showroom and online. Ends Sunday, Nov 29."), then anything else she adds. A headline week has no discount, so it has no terms. The button opens the whole shop by default for spend more, save more and for a percent off everything, since both count the whole order and the sale page lists only marked-down items; she can pick another page.

The same file decides the rules in her browser, on the server and in the build: `src/lib/sunny-side/special.mjs`. Its tests are in `special.test.mjs`. The store is `special-store.mjs`, a D1 table that creates itself on first use.

The preview shows the top of the real email at phone and computer widths. It measures, at 320 and 390 px, whether the button stays on the first screen and whether anything spills, using the same rules as `verify.mjs`, and it won't save a special that would fail them. Saving checks the version the page loaded, so two managers can't overwrite each other. The Today page shows a task when the coming Tuesday's email has no special.

## The standard

`verify.mjs` renders each email six ways:
- Apple Mail's engine (WebKit) at 320 and 390 px;
- Chrome's engine at 390 px and on desktop;
- Gmail web and the Gmail app, loaded the way Gmail serves the email: no web font, and the CSS Gmail strips taken out.

A render fails on any of these:
- on a phone, a sale button more than 600 px down (about what Apple Mail shows before scrolling);
- a color that isn't a brand color;
- anything off the grid: photo rows must run the full 600 px, and cards and the words that start each line must sit on the 536 px column (20 px margins on phones);
- text spilling out of its box;
- HTML code showing as text;
- a link under 44 px tall;
- heading order;
- a missing alt or a broken image;
- an image with dark artwork on a transparent background (Gmail and Outlook darken backgrounds in dark mode but never images, so that artwork disappears);
- a photo-wall product without its name and price, or a name over two lines;
- sideways scrolling;
- two links to the same address;
- a failed request.

A source check also fails the build on CSS Gmail strips: negative margins, positioning, flex and grid. The build itself stops on a subject or preheader that promises a discount the offer doesn't give, and on a photo-wall product that's out of stock.

## Design rules

- **Colors.** Only the ones the live site shows:
  - gold #FFD400 means buy;
  - teal #2B7A96 means events;
  - charcoal #2C2C2C is for text;
  - stone #6B6B68 is for rules;
  - plus white.
- **The charity section.** "Every purchase builds a dream room" is built the way sunshineonaranneyday.com builds its own home page, from its live styles and its brand guide at /branding/:
  - a Warm Gray #F5F4F0 hero with the guide's small-use logo (no tagline), laid on its own Warm Gray tile (`email/soard-logo-warm-tile` in Cloudflare Images) so its dark lettering stays readable in dark mode;
  - a "Where 100% of our profits go" label;
  - a Libre Baskerville headline whose key words are italic over the site's yellow highlighter (Sunshine Yellow at 30% over the lower half);
  - the reveal photo, rounded like the site's, with a caption;
  - a two-sentence story in Outfit;
  - the site's yellow pill button;
  - then its impact strip: Sunshine Yellow #FFDA24 numbers on Dark Deep #1E1F25.

  `verify.mjs` holds the section (class `soard`) to the charity's colors and everything else to the store's.
- **Font.** DM Sans; the charity section uses Libre Baskerville and Outfit. Outlook falls back to Arial and Gmail to Helvetica. The charity headline falls back to Georgia, but its numbers to Times New Roman, because Georgia's old-style figures made "$0" read as "$o".
- **Layout.** Words and cards sit on one 536 px column; photos run the full 600 px. A photo sits directly on top of the block it belongs to, and white space separates it from any block it doesn't. The photo wall's gaps sit inside its tiles, because Gmail strips the negative margins that would otherwise do it. The wall is never more than two products across, so a name and price stay readable on a 320 px phone; an odd count leads with one wide product.
- **First screen.** A slim masthead, a 2:1 top photo, and fine print under the button keep the sale button on a phone's first screen.

The rest is in the `email.mjs` header.

`{{ address }}` and `{{ unsubscribe_url }}` are Kit tags that Kit fills in at send time.
