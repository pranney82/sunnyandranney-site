# Sales tax worker

From 8 AM Eastern on the 1st, tells the store that last month's Georgia sales
and use tax return (ST-3, due the 20th) is ready to file. The email goes to the
store manager with the owner copied, and replies go to the owner. It says what's
owed and by when, and has one button to the month's filing page in the admin.
Three days before it's due, if the month isn't marked filed, the store gets one
reminder. Staff still file and pay in the Georgia Tax Center themselves.

The admin's **Sales tax** page (`/admin/sales-tax/`) shows the month to file,
the last month sent, the next one, and any problem. Each month has a filing page
(`/admin/sales-tax/2026-10/`) laid out in the Georgia Tax Center's own order:
Start the return, ST-3 Long Form (Part A), Calculate Total Sales Tax (Part B),
Calculate Total Use Tax, Vendor's Compensation and Review, then Submit. Every number to type has a copy
button that copies it the way the Tax Center takes it (`12345.67`). Every number
the Tax Center works out is shown so its review screen can be checked against it.
Step 1 has the button to the Tax Center's sign-in (`https://gtc.dor.ga.gov/_/`;
the bare `gtc.dor.ga.gov/` answers 404), the store's Tax Center username and
sales tax number with copy buttons, who gets the two-step code, and what to do
if a login is forgotten. A manager saves those once on the page (D1
`sales_tax_settings`). The password is never kept: it stays in the browser or a
password manager, and a save that looks like a password is refused.
Shopify's report for the month is there as a PDF and a spreadsheet. Staff mark
the month filed with the Tax Center's confirmation number. The page keeps when
it was first opened and when the month was marked filed, so filing time is
measured without a stopwatch.

## How it works

- **Schedule.** A cron runs every 30 minutes. `src/lib/sales-tax/run.mjs` waits
  for 8 AM Eastern on the 1st (daylight time included), then sends the month
  before, once. After a failure it tries again on each run until it goes (a
  20-minute wait between tries, so each half-hourly run counts).
  After 2 hours of failing it emails `SALES_TAX_ALERT_TO` once.
- **Shopify.** ShopifyQL through the Admin API (`shopifyqlQuery`, version
  2026-10), read with a Dev Dashboard app's client credentials. The app needs
  only `read_reports`. Four reports: the month's totals, each day, sales by
  shipping region, and taxes by region, name and rate.
- **The Tax Center's arithmetic.** `gtcReturn()` works out what the Tax Center
  will: Part B multiplies each row's taxable sales by its rate (Georgia 4%,
  Fulton 060 3.75%), line 4 is their sum, line 9 is the tax collected beyond it,
  and vendor's compensation is on both. Fulton 060 is Fulton County outside
  Atlanta, Hapeville, College Park and East Point (codes 060A, 800, 801, 802),
  7.75% in all (Georgia's rate chart from October 1, 2026).
- **The return's lines.** Shopify keeps no taxable-sales figure, so taxable
  sales are the tax collected divided by the rate. Exempt sales are the rest
  of the store's sales. Vendor's compensation is 3% of the first $3,000 of tax
  plus 0.5% of the rest, kept only when the return is filed and paid on time.
  Anything that looks off (a tax charged on a different amount of sales,
  another state, sales shipped out of Georgia, Shopify's own sums not adding up)
  goes in a "Check before filing" box.
- **No wrong numbers.** If Shopify's report can't be read (no totals, a value
  that isn't money, a tax with no rate), nothing is sent and the reason shows
  on the admin page.
- **Sending.** Cloudflare Email Service through the `send_email` binding, from
  `reports@mail.sunnyandranney.com`. `mail.sunnyandranney.com` is onboarded to
  Email Sending with its own bounce, DKIM and DMARC records. The store's own
  mail is Google Workspace on `sunnyandranney.com` and is untouched. Don't turn
  on Email Routing for `sunnyandranney.com`, because it would replace Google's
  MX records.
- **State.** D1 table `sales_tax_months` (it creates itself, and adds newer
  columns to an older table in place): one row per month, with tries, the
  email's id, the figures, the PDF and the spreadsheet, the last error, when the
  filing page was first opened, who marked it filed with which confirmation
  number, and when the reminder went. A month sent before files were kept gets
  them from Shopify, but only if Shopify still says what was sent. A
  month is claimed with one conditional upsert, so two runs at once send one
  email.

## Settings

| Setting | What it is |
|---|---|
| `SHOPIFY_CLIENT_ID` | Secret. The Shopify app's client ID |
| `SHOPIFY_CLIENT_SECRET` | Secret. The Shopify app's client secret |
| `SALES_TAX_TO` | Secret. The store manager |
| `SALES_TAX_CC` | Secret. Copied, comma-separated |
| `SALES_TAX_REPLY_TO` | Secret. Where a reply goes |
| `SALES_TAX_ALERT_TO` | Secret. Who hears when a month fails for 2 hours |
| `SALES_TAX_REPLY_NAME` | Plain variable in `wrangler.toml`. The name the email gives for replies |

The addresses are secrets only to keep them out of this public repo.

```sh
npm run deploy:sales-tax
npx wrangler secret put SHOPIFY_CLIENT_SECRET --config workers/sales-tax/wrangler.toml
```

## Checking a month

`scripts/sales-tax-preview.mjs` reads a month from Shopify, prints the
return's lines, and writes the email, the PDF and the spreadsheet to a folder.
It never sends. Any env file with a `read_reports` app's keys works:

```sh
node scripts/sales-tax-preview.mjs --env-file <file> --month 2026-10
```

To send a month again, delete its row from `sales_tax_months` (remote D1). The
next run sends it, as long as it is still the month before this one.

## After Shopify

When the store moves to Medusa, only the reading side changes:
`figuresFrom()` in `src/lib/sales-tax/figures.mjs` takes plain rows.
