/**
 * Sunny & Ranney's sales tax figures for Georgia's monthly return (ST-3)
 * ===========================================================================
 * Shopify's own reports, read with ShopifyQL through the Admin API
 * (shopifyqlQuery, scope read_reports) and worked into the lines Georgia's
 * return asks for:
 *
 *  - total sales (Part A line 1), exempt sales (line 2), taxable sales
 *    (line 3), taxable sales by county (Part B), the tax collected (line 7),
 *    and what's left to pay after the vendor's compensation a return filed and
 *    paid on time keeps (Part C);
 *  - each tax Shopify charged and what it came to;
 *  - Shopify's "Total sales breakdown" for the month and every day of it.
 *
 * Shopify keeps no taxable-sales figure, so taxable sales are the tax it
 * collected divided by the rate: the tax was already rounded order by order,
 * so this can be a few dollars off. Exempt sales are what's left of the
 * store's sales.
 *
 * Everything here is pure apart from the two Shopify calls, so the tests feed
 * it rows. Once the store leaves Shopify, only the reading side changes:
 * figuresFrom() takes plain rows.
 *
 * Ported from the SOARD website session's tested version, kept in
 * docs/sales-tax-handoff/ (not in git).
 */

export const SHOP_DOMAIN = 'e89vsg-er.myshopify.com';
export const API_VERSION = '2026-10';
export const SEND_HOUR_ET = 8;
export const TZ = 'America/New_York';
const STATE_RATE = 0.04;
// Georgia's jurisdiction codes, as the ST-3's own instructions give them (060A, 044A: inside Atlanta)
const COUNTY_CODES = { Fulton: '060', DeKalb: '044' };

const shopDomain = (env) => String(env?.SHOPIFY_STORE_DOMAIN || SHOP_DOMAIN).trim();

// ─── Dates ───────────────────────────────────────────────────────────

/** Eastern year, month (1-12), day and hour */
export function eastern(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) };
}

/** The month to file now ('YYYY-MM'), or null before 8 AM Eastern on the 1st */
export function dueMonth(now) {
  const e = eastern(now);
  if (e.day === 1 && e.hour < SEND_HOUR_ET) return null;
  const y = e.month === 1 ? e.year - 1 : e.year;
  const m = e.month === 1 ? 12 : e.month - 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export const daysIn = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
export const monthName = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** The return's due date: the 20th of the next month, a weekend moved to Monday → { iso, words } */
export function dueDate(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 20));
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return { iso: d.toISOString().slice(0, 10), words: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) };
}

// ─── Money (whole cents) ─────────────────────────────────────────────

/** A ShopifyQL money value as whole cents: '1,234.56', '$-12', 3.5 or { amount }. null when it isn't a number. */
export function readCents(v) {
  if (v && typeof v === 'object' && 'amount' in v) v = v.amount;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Math.round(Number.parseFloat(s) * 100);
}
export const cents = (v) => readCents(v) ?? 0;

export function money(c) {
  const s = `$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return c < 0 ? `-${s}` : s;
}

/** A ShopifyQL rate ('4%', '0.04' or '4') as a fraction. No sales tax is 20% or more, and none is under 0.2%. */
export function rateOf(v) {
  const s = String(v ?? '').trim();
  const n = Number.parseFloat(s.replace('%', ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return s.endsWith('%') || n >= 0.2 ? n / 100 : n;
}
export const pct = (r) => `${Number((r * 100).toFixed(4))}%`;

// ─── Shopify ─────────────────────────────────────────────────────────

const NO_REPORTS =
  'The Shopify app isn’t allowed to read reports. Add read_reports to the app’s access in Shopify’s Dev Dashboard, release it, and approve it on the store.';

/** The app's own token (client credentials grant). Throws in words staff can act on. */
export async function shopifyToken(env, fetchImpl = fetch) {
  const res = await fetchImpl(`https://${shopDomain(env)}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    // Shopify answers a 400 page titled "Oauth error <code>"
    const page = await res.text().catch(() => '');
    const code = page.match(/Oauth error ([a-z_]+)/i)?.[1] || '';
    const why =
      code === 'application_cannot_be_found'
        ? 'Shopify doesn’t know the app by SHOPIFY_CLIENT_ID, so the client ID is wrong or it went into the secret’s place. Paste the app’s client ID again.'
        : code === 'invalid_request'
          ? 'Shopify knows the app but not SHOPIFY_CLIENT_SECRET with it. Paste the app’s client secret again, and check the app is installed on the store.'
          : 'Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET on the sales-tax worker in Cloudflare, and that the app is installed on the store.';
    throw new Error(`Shopify refused the app’s keys (HTTP ${res.status}${code ? `, ${code}` : ''}). ${why}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Shopify gave no token for the app’s keys.');
  const scopes = String(j.scope || '').split(',').map((s) => s.trim());
  if (j.scope && !scopes.includes('read_reports')) throw new Error(NO_REPORTS);
  return j.access_token;
}

/** One ShopifyQL query → rows as objects keyed by column name */
export async function shopifyql(env, token, query, fetchImpl = fetch) {
  const res = await fetchImpl(`https://${shopDomain(env)}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: 'query Report($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name dataType } rows } parseErrors } }',
      variables: { q: query },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Shopify’s reports answered HTTP ${res.status}.`);
  const j = await res.json().catch(() => ({}));
  if (j.errors?.length) {
    const denied = j.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED' || /access denied|read_reports/i.test(e.message || ''));
    throw new Error(denied ? NO_REPORTS : `Shopify’s reports: ${j.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  }
  const r = j.data?.shopifyqlQuery;
  if (r?.parseErrors?.length) throw new Error(`Shopify couldn’t read the report: ${r.parseErrors.join('; ').slice(0, 300)}`);
  const t = r?.tableData;
  if (!t) throw new Error('Shopify’s reports came back empty.');
  const names = (t.columns || []).map((c) => c.name);
  let rows = t.rows;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch {
      rows = [];
    }
  }
  return (rows || []).map((row) => (Array.isArray(row) ? Object.fromEntries(names.map((n, i) => [n, row[i]])) : row));
}

export const SALES_COLUMNS = ['gross_sales', 'discounts', 'sales_reversals', 'net_sales', 'shipping_charges', 'return_fees', 'taxes', 'total_sales'];
/** Shopify's own names for its columns, as its Total sales breakdown shows them */
export const SALES_LABELS = {
  gross_sales: 'Gross sales',
  discounts: 'Discounts',
  sales_reversals: 'Sales reversals',
  net_sales: 'Net sales',
  shipping_charges: 'Shipping charges',
  return_fees: 'Return fees',
  taxes: 'Taxes',
  total_sales: 'Total sales',
};

/** The four reports for one month ('YYYY-MM') */
export function queries(month) {
  const range = `SINCE ${month}-01 UNTIL ${month}-${String(daysIn(month)).padStart(2, '0')}`;
  return {
    total: `FROM sales SHOW ${SALES_COLUMNS.join(', ')} ${range}`,
    days: `FROM sales SHOW ${SALES_COLUMNS.join(', ')} GROUP BY day ${range} ORDER BY day ASC`,
    regions: `FROM sales SHOW net_sales, shipping_charges GROUP BY shipping_region ${range}`,
    taxes: `FROM sales_taxes SHOW sales_taxes GROUP BY tax_region, tax_name, tax_rate ${range}`,
  };
}

/** Shopify's four reports for the month, as rows */
export async function readShopify(env, month, { fetchImpl = fetch } = {}) {
  const token = await shopifyToken(env, fetchImpl);
  const q = queries(month);
  const [total, days, regions, taxes] = await Promise.all([q.total, q.days, q.regions, q.taxes].map((x) => shopifyql(env, token, x, fetchImpl)));
  return { total, days, regions, taxes };
}

/** Shopify's reports for the month, read and worked into the return's lines */
export async function readMonth(env, month, opts = {}) {
  return figuresFrom(month, await readShopify(env, month, opts));
}

// ─── The figures ─────────────────────────────────────────────────────

const isGeorgia = (s) => !s || /^(georgia|ga|us-ga)$/i.test(String(s).trim());
export { isGeorgia };
/** A name that's a local tax's: a county, city, or one of Georgia's special local taxes */
const LOCAL = /county|\bco\b|city|tsplost|splost|lost|most|marta|special|district|educ/i;
/** Georgia's own 4%: 'Georgia State Tax', 'GA State Tax', 'State Tax', or an unlabeled 4% line that isn't local */
const isState = (t) => !LOCAL.test(t.name) && (/\bstate\b/i.test(t.name) || Math.abs(t.rate - STATE_RATE) < 1e-9);
/** A county as the return names it: 'Fulton' → 'Fulton County'; a city or special district keeps its own name */
export const countyName = (c) => `${c.name}${/county|city|tsplost|most|marta/i.test(c.name) ? '' : ' County'}`;
/** Whole cents as the Tax Center takes them: 1234567 → '12345.67' */
export const plainCents = (c) => (c / 100).toFixed(2);
/** The county a local tax belongs to ('Fulton County Tax', 'Fulton Co Tsplost Sp' → Fulton), else the tax's own name */
export const countyOf = (name) => String(name).match(/^(.+?)\s+(County|Co)\b/i)?.[1]?.trim() || String(name).trim();
const sumOf = (list, k) => list.reduce((a, x) => a + x[k], 0);
const SLACK = 100; // a dollar of rounding before a total is called off

/**
 * Shopify's rows → everything the email shows. Pure, so the tests can feed it.
 * `problems` are reasons not to send at all (Shopify's report couldn't be read); `notes` go in the email.
 */
export function figuresFrom(month, { total = [], days = [], regions = [], taxes = [] }) {
  const problems = [];
  const unreadable = new Set();
  const read = (row, k) => {
    const c = readCents(row?.[k]);
    if (c === null) {
      unreadable.add(k);
      return 0;
    }
    return c;
  };

  if (!total.length) problems.push('Shopify’s sales report came back without the month’s totals.');
  const t0 = total[0] || {};
  const breakdown = Object.fromEntries(SALES_COLUMNS.map((k) => [k, read(t0, k)]));
  // Every day of the month, zeros where Shopify had none (as its own report shows them)
  const byDay = new Map(days.map((d) => [String(d.day || '').slice(0, 10), d]));
  const daily = Array.from({ length: daysIn(month) }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, '0')}`;
    const d = byDay.get(day) || {};
    return { day, ...Object.fromEntries(SALES_COLUMNS.map((k) => [k, read(d, k)])) };
  });
  if (days.length && ![...byDay.keys()].some((d) => d.startsWith(month))) problems.push('Shopify’s day-by-day report came back without days the site could read.');

  // Line 1: sales sourced to Georgia (the shop's own sales have no shipping region); shipped out of state isn't on it
  let gaSales = 0;
  let outside = 0;
  for (const r of regions) {
    const c = read(r, 'net_sales') + read(r, 'shipping_charges');
    if (isGeorgia(r.shipping_region)) gaSales += c;
    else outside += c;
  }
  if (!regions.length) gaSales = breakdown.net_sales + breakdown.shipping_charges;

  const lines = taxes
    .map((r) => ({ region: String(r.tax_region || '').trim(), name: String(r.tax_name || '').trim() || 'Tax', rate: rateOf(r.tax_rate), tax: read(r, 'sales_taxes') }))
    .filter((x) => x.tax !== 0)
    .sort((a, b) => (isGeorgia(a.region) === isGeorgia(b.region) ? 0 : isGeorgia(a.region) ? -1 : 1) || b.rate - a.rate || a.name.localeCompare(b.name));
  for (const x of lines) if (!x.rate) problems.push(`Shopify gave ${x.name} no rate the site could read, so its taxable sales can’t be worked out.`);
  if (unreadable.size) problems.push(`Shopify’s report had values the site couldn’t read as money (${[...unreadable].join(', ')}).`);

  const ga = lines.filter((x) => isGeorgia(x.region));
  const away = lines.filter((x) => !isGeorgia(x.region));
  const stateLines = ga.filter(isState);
  const local = ga.filter((x) => !isState(x));
  const stateTax = sumOf(stateLines, 'tax');
  const collected = sumOf(ga, 'tax');
  const notes = [];

  // Local taxes by county: each line's rate adds to the county's
  const counties = [];
  for (const x of local) {
    const name = countyOf(x.name);
    let c = counties.find((k) => k.name === name);
    if (!c) counties.push((c = { name, code: COUNTY_CODES[name] || null, rate: 0, tax: 0, lines: [] }));
    c.rate += x.rate;
    c.tax += x.tax;
    c.lines.push(x);
  }
  // Taxable sales from the tax: one county means one base for the state and county together (the steadiest figure)
  const single = counties.length === 1 && stateTax > 0;
  for (const c of counties) {
    c.taxable = c.rate > 0 ? Math.round((single ? c.tax + stateTax : c.tax) / (single ? c.rate + STATE_RATE : c.rate)) : 0;
    // A line far off the sales the others were charged on (the state tax's, else the county's biggest): some sales
    // skipped one of its taxes, and those go on their own line of the return (a TSPLOST-exempt sale, say)
    const main = c.lines.reduce((a, x) => (x.rate > a.rate ? x : a), c.lines[0]);
    const ref = single ? Math.round(stateTax / STATE_RATE) : Math.round(main.tax / main.rate);
    const off = c.lines.filter((x) => x.rate > 0 && Math.abs(Math.round(x.tax / x.rate) - ref) > Math.max(5000, ref * 0.01));
    if (off.length) {
      notes.push(
        `${off.map((x) => x.name).join(' and ')} ${off.length > 1 ? 'were' : 'was'} charged on a different amount of sales than the rest of ${c.name}’s taxes. Some sales may be exempt from it, and those go on their own line of the return. Check Shopify before filing.`,
      );
    }
  }
  const taxable = single ? counties[0].taxable : stateTax > 0 ? Math.round(stateTax / STATE_RATE) : 0;
  const exempt = gaSales - taxable;
  if (exempt < 0) notes.push(`Taxable sales come out ${money(-exempt)} more than the store’s sales, so some tax may have been charged twice or on a refunded sale. Check Shopify before filing.`);
  // Without the state's line there's no taxable-sales figure, so every line of the return would be wrong
  if (stateLines.length === 0 && ga.length) problems.push(`Shopify’s Georgia taxes this month have no state line the site recognizes (${ga.map((x) => x.name).join(', ')}), so the return’s lines can’t be worked out.`);
  if (away.length) notes.push(`Shopify also collected ${money(sumOf(away, 'tax'))} of tax for ${[...new Set(away.map((x) => x.region || 'another state'))].join(', ')}. That isn’t on the Georgia return.`);
  if (outside) notes.push(`${money(outside)} of sales were shipped outside Georgia and aren’t on the Georgia return.`);
  const otherTax = breakdown.taxes - collected - sumOf(away, 'tax');
  if (Math.abs(otherTax) > SLACK) {
    notes.push(`Shopify’s taxes total (${money(breakdown.taxes)}) and its tax lines (${money(collected + sumOf(away, 'tax'))}) differ by ${money(Math.abs(otherTax))}. Check Shopify before filing.`);
  }
  // Shopify's own sums, which hold every month: a report read wrong shows here first
  const b = breakdown;
  if (total.length && Math.abs(b.gross_sales + b.discounts + b.sales_reversals - b.net_sales) > SLACK) {
    notes.push(`Shopify’s gross sales, discounts and sales reversals don’t add up to its net sales (${money(b.net_sales)}). Check Shopify before filing.`);
  }
  if (total.length && Math.abs(b.net_sales + b.shipping_charges + b.return_fees + b.taxes - b.total_sales) > SLACK) {
    notes.push(`Shopify’s net sales, shipping, return fees and taxes don’t add up to its total sales (${money(b.total_sales)}). Check Shopify before filing.`);
  }
  if (days.length && Math.abs(sumOf(daily, 'total_sales') - b.total_sales) > SLACK) {
    notes.push(`The days in the attached report add up to ${money(sumOf(daily, 'total_sales'))}, not the month’s ${money(b.total_sales)}. Use Shopify’s own report for the days.`);
  }

  const ret = {
    totalSales: gaSales,
    exempt: Math.max(exempt, 0),
    taxable,
    counties: counties.map(({ name, code, rate, tax, taxable: tx }) => ({ name, code, rate: Number(rate.toFixed(6)), tax, taxable: tx })),
    collected,
  };
  const gtc = gtcReturn(ret);
  if (gtc.excess < -SLACK) {
    notes.push(`The Georgia Tax Center will work out ${money(gtc.line4)} of tax on these sales, ${money(-gtc.excess)} more than Shopify collected. The store owes Georgia’s figure. Check Shopify before filing.`);
  }
  return {
    month,
    due: dueDate(month).iso,
    breakdown,
    daily,
    taxes: lines.map(({ region, name, rate, tax }) => ({ region, name, rate, tax })),
    ret: { ...ret, comp: gtc.comp, pay: gtc.pay },
    notes,
    problems: [...new Set(problems)],
  };
}

/** Part C: 3% of the first $3,000 of tax, 0.5% of the rest, kept only when the return is filed and paid on time */
export const vendorComp = (tax) => Math.round(Math.min(tax, 300000) * 0.03 + Math.max(tax - 300000, 0) * 0.005);

/**
 * What the Georgia Tax Center works out from the lines typed into it, so the review screen can be checked against it.
 * Part B multiplies each line's taxable sales by its rate: the state's 4% on line 1, then each county's local rate
 * (Fulton 060: 3.75%). Part A line 9 is the tax collected beyond that, and Part C's vendor's compensation is on both.
 * ret: figuresFrom().ret (a stored month's works too) → { line3, state, counties, line4, excess, comp, pay }
 */
export function gtcReturn(ret) {
  // Line 3 is the Tax Center's own line 1 minus line 2, which is the state's row in Part B. It differs from `taxable` only
  // when taxable sales come out above the store's sales (a note says to check), and then the Tax Center's figure is the one that counts.
  const line3 = ret.totalSales - ret.exempt;
  const state = { code: '000', name: 'Georgia', taxable: line3, rate: STATE_RATE, due: Math.round(line3 * STATE_RATE) };
  const counties = (ret.counties || []).map((c) => ({ ...c, due: Math.round(c.taxable * c.rate) }));
  const line4 = state.due + counties.reduce((a, c) => a + c.due, 0);
  const excess = ret.collected - line4;
  const owed = line4 + Math.max(excess, 0);
  const comp = vendorComp(owed);
  return { line3, state, counties, line4, excess, comp, pay: owed - comp };
}
