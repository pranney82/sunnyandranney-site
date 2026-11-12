import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAME_MAX, displayName, handleOf, isProductPage, money, photoFor, productFromPage, quantitiesFromShop } from './product.mjs';

const page = (product) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', ...product })}</script></head></html>`;

test('a product page gives its name, price, stock and photos', () => {
  const p = productFromPage(
    page({ name: 'Vito Swivel Chair - Pebble - ELMT', image: ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.png'], offers: { '@type': 'Offer', price: '500.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } }),
  );
  assert.deepEqual(p, { name: 'Vito Swivel Chair - Pebble - ELMT', price: 500, inStock: true, images: ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.png'] });
  assert.equal(productFromPage(page({ name: 'X', image: 'u', offers: [{ price: '10', availability: 'https://schema.org/OutOfStock' }] })).inStock, false);
  assert.throws(() => productFromPage('<html></html>'), /no product data/);
  assert.throws(() => productFromPage(page({ name: 'X', offers: { availability: 'InStock' } })), /no product name or price/);
});

test('catalog names come out fit for customers', () => {
  // The store's real names, as its pages carried them on Nov 11, 2026
  assert.equal(displayName('Vito Swivel Chair - Pebble - ELMT'), 'Vito Swivel Chair, Pebble');
  assert.equal(displayName('Harper Swivel Accent Chair - Cloud - JFN'), 'Harper Swivel Accent Chair, Cloud');
  assert.equal(displayName('36" MARLOWE GOLD MIRROR - OLX'), '36" Marlowe Gold Mirror');
  assert.equal(displayName('Kuga Swivel |Sand - ELMT'), 'Kuga Swivel, Sand');
  assert.equal(displayName('Terrace 4 Door Cabinet - LFI'), 'Terrace 4 Door Cabinet');
  assert.equal(displayName('26"Contemporary Velvet and Metal Counter Stool'), '26" Contemporary Velvet and Metal Counter Stool');
  assert.equal(displayName('Casimere Swivel Glider- Pashimina - BHF'), 'Casimere Swivel Glider, Pashimina');
  assert.equal(displayName('Mid-Century 4-Door Sideboard'), 'Mid-Century 4-Door Sideboard');
  assert.equal(displayName('Everly Swivel Chair -Taupe- JFN'), 'Everly Swivel Chair, Taupe');
  assert.equal(displayName('SIDEBOARD 4-DOOR'), 'Sideboard 4-Door');
  // Two of them are too long for a tile on a small phone, so the brief gives a short name
  assert.ok(displayName('Harper Swivel Accent Chair - Cloud - JFN').length > NAME_MAX);
  assert.ok(displayName('Vito Swivel Chair - Pebble - ELMT').length <= NAME_MAX);
});

test('stock comes from the shop page’s own counts, not the product page', () => {
  const shop =
    '<div class="card" data-handle="vito-swivel-chair-pebble-elmt" data-total-qty="0" data-on-sale="false"></div>' +
    '<a data-handle="harper-swivel-accent-chair-cloud-jfn" data-total-qty="2"></a>' +
    '<div data-handle="harper-swivel-accent-chair-cloud-jfn" data-total-qty="9"></div>'; // a repeat card: the first counts
  const qty = quantitiesFromShop(shop);
  assert.equal(qty.get('vito-swivel-chair-pebble-elmt'), 0);
  assert.equal(qty.get('harper-swivel-accent-chair-cloud-jfn'), 2);
  assert.equal(qty.get('not-in-the-shop'), undefined);
  assert.throws(() => quantitiesFromShop('<html></html>'), /no product cards/);
  assert.equal(handleOf('https://sunnyandranney.com/shop/vito-swivel-chair-pebble-elmt/?utm_source=x'), 'vito-swivel-chair-pebble-elmt');
});

test('prices read the way the store writes them', () => {
  assert.equal(money(500), '$500');
  assert.equal(money(1200), '$1,200');
  assert.equal(money(1299.99), '$1,299.99');
  assert.equal(money('130.00'), '$130');
});

test('the tile photo skips PNGs, which Shopify cannot shrink', () => {
  assert.equal(photoFor(['https://cdn.shopify.com/x.png?v=1', 'https://cdn.shopify.com/y.jpg?v=2']), 'https://cdn.shopify.com/y.jpg?v=2');
  assert.equal(photoFor(['https://cdn.shopify.com/x.PNG']), null);
  assert.equal(photoFor(['https://cdn.shopify.com/z.webp']), 'https://cdn.shopify.com/z.webp');
});

test('only the store’s own product pages count as products', () => {
  assert.equal(isProductPage('https://sunnyandranney.com/shop/vito-swivel-chair-pebble-elmt/'), true);
  assert.equal(isProductPage('https://sunnyandranney.com/shop/?collection=new-arrivals'), false);
  assert.equal(isProductPage('https://other.example/shop/x/'), false);
});
