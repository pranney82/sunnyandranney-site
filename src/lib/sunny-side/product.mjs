/**
 * A product on sunnyandranney.com, as the weekly email shows it
 * ===========================================================================
 * Each photo-wall tile is a product: its photo, its name and its price, all one link to its
 * page on sunnyandranney.com, where it can be bought. The build reads each product from its
 * own page (the structured data search engines read), so the email always shows what the
 * store shows today, and a product that has sold out stops the build instead of going out.
 * No Node or browser APIs, so the build and (later) the admin's product picker share it.
 */

/** The longest name that fits two lines in a tile on a 320px phone. Longer names need a short one. */
export const NAME_MAX = 28;

/** The product on a page: { name, price, inStock, images }, from its schema.org Product data. */
export function productFromPage(html) {
  for (const [, json] of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : data['@graph'] || [data];
    const p = items.find((it) => it && (it['@type'] === 'Product' || (Array.isArray(it['@type']) && it['@type'].includes('Product'))));
    if (!p) continue;
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    const price = Number(offer?.price);
    if (!p.name || !Number.isFinite(price)) throw new Error('the page has no product name or price.');
    return {
      name: String(p.name),
      price,
      inStock: /InStock|LimitedAvailability/i.test(String(offer?.availability || '')),
      images: (Array.isArray(p.image) ? p.image : [p.image]).filter(Boolean).map(String),
    };
  }
  throw new Error('the page has no product data.');
}

/**
 * The catalog's name made fit for customers: no vendor code on the end ("- ELMT"), no shouting
 * capitals, a space after an inch mark, and commas instead of dashes and bars between parts.
 *   "Vito Swivel Chair - Pebble - ELMT"     -> "Vito Swivel Chair, Pebble"
 *   "36\" MARLOWE GOLD MIRROR - OLX"         -> "36\" Marlowe Gold Mirror"
 *   "Kuga Swivel |Sand - ELMT"              -> "Kuga Swivel, Sand"
 */
export function displayName(raw) {
  let name = String(raw).replace(/\s*\|\s*/g, ' - ').replace(/\s+/g, ' ').trim();
  name = name.replace(/(\d)"(?=[A-Za-z])/g, '$1" ');
  // The vendor code after a dash with a space on either side ("- ELMT", "Taupe- JFN"); "4-DOOR" isn't one
  name = name.replace(/(\s+-\s*|\s*-\s+)[A-Z]{2,5}$/, '');
  const letters = name.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase()) {
    name = name.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (_, b, c) => b + c.toUpperCase());
  }
  // A dash with a space on either side separates parts ("Glider- Pashimina"); "4-Door" stays one word.
  return name.replace(/\s+-\s*|\s*-\s+/g, ', ');
}

/** "$500", "$1,200", "$1,299.99" */
export function money(n) {
  const [whole, cents] = Number(n).toFixed(2).split('.');
  return '$' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (cents === '00' ? '' : '.' + cents);
}

/** The product's first photo that isn't a PNG: Shopify can't shrink PNGs, and they run 250KB and up. */
export const photoFor = (images) => images.find((u) => !/\.png(\?|$)/i.test(u)) || null;

/**
 * How many of each product the store has, by handle, from the shop page's product cards: the same
 * count the site's own sale and stock filters use. A product page's structured data says "InStock"
 * even at zero when the store keeps selling on order, so it can't be the stock check.
 */
export function quantitiesFromShop(html) {
  const qty = new Map();
  for (const [tag] of String(html).matchAll(/<[^>]*\bdata-handle="[^"]+"[^>]*>/g)) {
    const handle = tag.match(/\bdata-handle="([^"]+)"/)[1];
    const n = tag.match(/\bdata-total-qty="(-?\d+)"/);
    if (n && !qty.has(handle)) qty.set(handle, Number(n[1]));
  }
  if (!qty.size) throw new Error('the shop page has no product cards with stock counts.');
  return qty;
}

/** A product page's handle: "https://sunnyandranney.com/shop/vito-swivel-chair-pebble-elmt/" -> "vito-swivel-chair-pebble-elmt" */
export const handleOf = (url) => url.split('?')[0].replace(/\/$/, '').split('/').pop();

/** True for a product page on the store's own site. */
export const isProductPage = (url) => /^https:\/\/sunnyandranney\.com\/shop\/[a-z0-9-]+\/?$/i.test(url.split('?')[0]);
