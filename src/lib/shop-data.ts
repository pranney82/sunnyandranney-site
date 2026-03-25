/**
 * Shared shop product-fetching logic.
 * Used by both the shop page and the static JSON endpoint
 * so that product data can be externalised from the HTML payload.
 */
import { getCollectionsStatic } from '@/lib/settings';
import type { Product } from '@/lib/shopify';

export interface ShopData {
  products: Product[];
  hasShopify: boolean;
  productCollections: Record<string, string[]>;
  collectionTitles: Record<string, string>;
  collectionSubcategories: Record<string, string[]>;
}

export async function fetchShopData(): Promise<ShopData> {
  const products: Product[] = [];
  let hasShopify = false;
  const productCollections: Record<string, string[]> = {};
  const collectionTitles: Record<string, string> = {};

  try {
    const shopify = await import('@/lib/shopify');
    const collectionSettings = await getCollectionsStatic();
    const enabledHandles = collectionSettings
      ?.filter(c => c.enabled)
      .sort((a, b) => a.order - b.order)
      .map(c => c.handle) ?? [];

    if (enabledHandles.length > 0) {
      const results = await Promise.all(
        enabledHandles.map(handle => shopify.getCollectionByHandle(handle, 100))
      );

      const seen = new Set<string>();
      for (const collection of results) {
        if (!collection) continue;
        collectionTitles[collection.handle] = collection.title;
        for (const product of collection.products) {
          if (!productCollections[product.handle]) {
            productCollections[product.handle] = [];
          }
          productCollections[product.handle].push(collection.handle);
          if (!seen.has(product.id)) {
            seen.add(product.id);
            products.push(product);
          }
        }
      }
    }
    hasShopify = products.length > 0;
  } catch (e) {
    console.error('[shop] Shopify fetch failed:', e instanceof Error ? e.message : e);
    console.error('[shop] Token present:', !!import.meta.env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN);
    console.error('[shop] Domain:', import.meta.env.PUBLIC_SHOPIFY_STORE_DOMAIN || '(missing, using default)');
  }

  // Build subcategory map
  const collectionSubcategories: Record<string, string[]> = {};
  for (const product of products) {
    const catName = product.category?.name;
    if (!catName || catName === 'Uncategorized') continue;
    const colHandles = productCollections[product.handle] || [];
    for (const handle of colHandles) {
      if (!collectionSubcategories[handle]) collectionSubcategories[handle] = [];
      if (!collectionSubcategories[handle].includes(catName)) {
        collectionSubcategories[handle].push(catName);
      }
    }
  }
  for (const handle of Object.keys(collectionSubcategories)) {
    collectionSubcategories[handle].sort();
  }

  return { products, hasShopify, productCollections, collectionTitles, collectionSubcategories };
}

/** Build the quick-view / search data map (images, variants, descriptions). */
export function buildProductDataMap(products: Product[]): Record<string, { i: string[]; v: Array<{ id: string; title: string; price: string; available: boolean; image: string }>; d: string }> {
  const map: Record<string, { i: string[]; v: Array<{ id: string; title: string; price: string; available: boolean; image: string }>; d: string }> = {};
  for (const product of products) {
    const allImages = product.images.edges.map(e => e.node.url);
    const allVariants = product.variants.edges.map(e => ({
      id: e.node.id,
      title: e.node.title,
      price: e.node.price.amount,
      available: e.node.availableForSale,
      image: e.node.image?.url || ''
    }));
    map[product.handle] = {
      i: allImages,
      v: allVariants,
      d: product.description?.slice(0, 300) || '',
    };
  }
  return map;
}
