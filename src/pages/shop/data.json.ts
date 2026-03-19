import type { APIRoute } from 'astro';
import { fetchShopData, buildProductDataMap } from '@/lib/shop-data';

export const prerender = true;

export const GET: APIRoute = async () => {
  const { products, collectionTitles, collectionSubcategories } = await fetchShopData();
  const productDataMap = buildProductDataMap(products);

  const payload = {
    collectionTitles,
    collectionSubcategories,
    productDataMap,
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
