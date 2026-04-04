// Shopify Storefront API Client
// Uses the Storefront API (not Admin API) — safe for client-side/public use

const SHOPIFY_STORE_DOMAIN = import.meta.env.PUBLIC_SHOPIFY_STORE_DOMAIN || 'sunnyandranney.myshopify.com';
const SHOPIFY_STOREFRONT_TOKEN = import.meta.env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN || '';

const STOREFRONT_API_URL = `https://${SHOPIFY_STORE_DOMAIN}/api/2025-01/graphql.json`;

interface ShopifyResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

async function shopifyFetch<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(STOREFRONT_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10000),
      });

      // Retry on rate-limit or server errors
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Shopify API ${response.status}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      const json: ShopifyResponse<T> = await response.json();

      if (json.errors) {
        // Throttled errors from Shopify GraphQL are retryable
        const isThrottled = json.errors.some(e => e.message.includes('Throttled'));
        if (isThrottled && attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        console.error('Shopify API errors:', json.errors);
        throw new Error(json.errors.map((e) => e.message).join(', '));
      }

      return json.data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < 2 && !lastError.message.includes('Shopify API errors')) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('Shopify fetch failed after retries');
}

// ─── Product Queries ─────────────────────────────────────────────

const PRODUCT_FRAGMENT = `
  fragment ProductFields on Product {
    id
    title
    handle
    description
    descriptionHtml
    createdAt
    productType
    category {
      id
      name
      ancestors {
        id
        name
      }
    }
    tags
    vendor
    availableForSale
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
      maxVariantPrice {
        amount
        currencyCode
      }
    }
    compareAtPriceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
    images(first: 6) {
      edges {
        node {
          url
          altText
          width
          height
        }
      }
    }
    variants(first: 10) {
      edges {
        node {
          id
          title
          availableForSale
          quantityAvailable
          price {
            amount
            currencyCode
          }
          compareAtPrice {
            amount
            currencyCode
          }
          selectedOptions {
            name
            value
          }
          image {
            url
            altText
          }
        }
      }
    }
    media(first: 10) {
      edges {
        node {
          mediaContentType
          ... on Video {
            id
            sources {
              url
              mimeType
            }
            previewImage {
              url
            }
          }
          ... on ExternalVideo {
            id
            host
            embeddedUrl
          }
        }
      }
    }
    seo {
      title
      description
    }
  }
`;

export async function getProducts(first = 24, cursor?: string, sortKey: 'BEST_SELLING' | 'CREATED_AT' = 'BEST_SELLING') {
  const query = `
    ${PRODUCT_FRAGMENT}
    query Products($first: Int!, $after: String) {
      products(first: $first, after: $after, sortKey: ${sortKey}, reverse: ${sortKey === 'CREATED_AT'}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            ...ProductFields
          }
        }
      }
    }
  `;

  const data = await shopifyFetch<{
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      edges: Array<{ node: Product }>;
    };
  }>(query, { first, after: cursor });

  return {
    products: data.products.edges.map((e) => e.node),
    pageInfo: data.products.pageInfo,
  };
}

export async function getProductByHandle(handle: string) {
  const query = `
    ${PRODUCT_FRAGMENT}
    query ProductByHandle($handle: String!) {
      product(handle: $handle) {
        ...ProductFields
      }
    }
  `;

  const data = await shopifyFetch<{ product: Product }>(query, { handle });
  return data.product;
}

export async function getCollections(first = 12) {
  const query = `
    query Collections($first: Int!) {
      collections(first: $first) {
        edges {
          node {
            id
            title
            handle
            description
            image {
              url
              altText
              width
              height
            }
            products(first: 4) {
              edges {
                node {
                  id
                  title
                  handle
                  images(first: 1) {
                    edges {
                      node {
                        url
                        altText
                      }
                    }
                  }
                  priceRange {
                    minVariantPrice {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyFetch<{
    collections: { edges: Array<{ node: Collection }> };
  }>(query, { first });

  return data.collections.edges.map((e) => e.node);
}

export async function getCollectionByHandle(handle: string, limit = Infinity) {
  const PAGE_SIZE = 50; // Reduced from 250 — large pages with nested fields cause Shopify internal errors
  const query = `
    ${PRODUCT_FRAGMENT}
    query CollectionByHandle($handle: String!, $first: Int!, $after: String) {
      collection(handle: $handle) {
        id
        title
        handle
        description
        image {
          url
          altText
          width
          height
        }
        products(first: $first, sortKey: BEST_SELLING, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              ...ProductFields
            }
          }
        }
      }
    }
  `;

  type CollectionResponse = Collection & {
    products: { pageInfo: { hasNextPage: boolean; endCursor: string }; edges: Array<{ node: Product }> };
  };

  const allProducts: Product[] = [];
  let cursor: string | undefined;
  let collectionMeta: CollectionResponse | null = null;

  do {
    const pageSize = Math.min(PAGE_SIZE, limit - allProducts.length);
    const data = await shopifyFetch<{ collection: CollectionResponse }>(
      query, { handle, first: pageSize, after: cursor }
    );

    if (!data.collection) return null;

    if (!collectionMeta) collectionMeta = data.collection;
    allProducts.push(...data.collection.products.edges.map((e) => e.node));

    if (allProducts.length >= limit || !data.collection.products.pageInfo.hasNextPage) {
      break;
    }
    cursor = data.collection.products.pageInfo.endCursor;
  } while (true);

  return {
    ...collectionMeta!,
    products: allProducts,
    pageInfo: { hasNextPage: false, endCursor: '' },
  };
}

// ─── Product Recommendations ────────────────────────────────────────

export async function getProductRecommendations(productId: string, first = 8) {
  const query = `
    ${PRODUCT_FRAGMENT}
    query Recommendations($productId: ID!) {
      productRecommendations(productId: $productId) {
        ...ProductFields
      }
    }
  `;

  try {
    const data = await shopifyFetch<{
      productRecommendations: Product[];
    }>(query, { productId });
    return (data.productRecommendations || []).slice(0, first);
  } catch {
    return [];
  }
}

export async function getProductsByType(productType: string, first = 8, excludeHandle?: string) {
  const query = `
    ${PRODUCT_FRAGMENT}
    query ProductsByType($first: Int!, $query: String!) {
      products(first: $first, query: $query, sortKey: BEST_SELLING) {
        edges {
          node {
            ...ProductFields
          }
        }
      }
    }
  `;

  try {
    const data = await shopifyFetch<{
      products: { edges: Array<{ node: Product }> };
    }>(query, { first: first + 1, query: `product_type:${productType}` });

    return data.products.edges
      .map(e => e.node)
      .filter(p => p.handle !== excludeHandle)
      .slice(0, first);
  } catch {
    return [];
  }
}

// ─── Category Taxonomy (build-time) ─────────────────────────────

export async function getCategoryNamesByCollection(
  handles: string[]
): Promise<Record<string, string[]>> {
  const aliases = handles
    .map((h, i) => `c${i}: collection(handle: ${JSON.stringify(h)}) { products(first: 100) { edges { node { category { name } } } } }`)
    .join(' ');

  try {
    const data = await shopifyFetch<Record<string, { products: { edges: Array<{ node: { category: { name: string } | null } }> } } | null>>(
      `{ ${aliases} }`
    );

    const result: Record<string, string[]> = {};
    handles.forEach((handle, i) => {
      const edges = data[`c${i}`]?.products?.edges || [];
      const names = new Set<string>();
      for (const e of edges) {
        const name = e.node.category?.name;
        if (name && name !== 'Uncategorized') names.add(name);
      }
      result[handle] = Array.from(names).sort();
    });
    return result;
  } catch (err) {
    console.error('[shopify] Failed to fetch category names:', err);
    return Object.fromEntries(handles.map(h => [h, []]));
  }
}

// ─── Cart / Checkout ─────────────────────────────────────────────

export async function createCart(lines: Array<{ merchandiseId: string; quantity: number }>) {
  const query = `
    mutation CartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
          totalQuantity
          cost {
            totalAmount {
              amount
              currencyCode
            }
          }
          lines(first: 50) {
            edges {
              node {
                id
                quantity
                merchandise {
                  ... on ProductVariant {
                    id
                    title
                    price {
                      amount
                      currencyCode
                    }
                    product {
                      title
                      handle
                      images(first: 1) {
                        edges {
                          node {
                            url
                            altText
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyFetch<{
    cartCreate: { cart: Cart; userErrors: Array<{ field: string; message: string }> };
  }>(query, { input: { lines } });

  return data.cartCreate;
}

export async function addToCart(cartId: string, lines: Array<{ merchandiseId: string; quantity: number }>) {
  const query = `
    mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart {
          id
          checkoutUrl
          totalQuantity
          cost {
            totalAmount {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyFetch<{
    cartLinesAdd: { cart: Cart; userErrors: Array<{ field: string; message: string }> };
  }>(query, { cartId, lines });

  return data.cartLinesAdd;
}

// ─── Image Optimization (Shopify CDN) ───────────────────────────

/**
 * Resize a Shopify CDN image URL.
 * Shopify CDN supports on-the-fly resizing via URL params:
 *   ?width=400&height=500&crop=center
 * This avoids downloading full-res images for thumbnails/cards.
 */
export function shopifyImageUrl(url: string, width?: number, height?: number, crop = 'center'): string {
  if (!url || !url.includes('cdn.shopify.com')) return url;

  const params = new URLSearchParams();
  if (width) params.set('width', String(width));
  if (height) params.set('height', String(height));
  if (crop && (width || height)) params.set('crop', crop);
  params.set('format', 'webp');

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.toString()}`;
}

/**
 * Generate srcset for responsive Shopify images.
 * Returns a srcset string for use in <img srcset="...">.
 */
export function shopifyImageSrcset(url: string, widths: number[] = [300, 600, 900, 1200]): string {
  if (!url || !url.includes('cdn.shopify.com')) return '';
  return widths.map(w => `${shopifyImageUrl(url, w)} ${w}w`).join(', ');
}

// ─── Helpers ─────────────────────────────────────────────────────

export function formatPrice(amount: string, currencyCode = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(parseFloat(amount));
}

/** Format price dropping .00 on whole numbers ($800 not $800.00) */
export function formatPriceShort(amount: number): string {
  return amount % 1 === 0 ? `$${amount.toLocaleString()}` : `$${amount.toFixed(2)}`;
}

export function getProductImage(product: Product, index = 0) {
  return product.images.edges[index]?.node;
}

export function isOnSale(product: Product): boolean {
  const compareAt = parseFloat(product.compareAtPriceRange.minVariantPrice.amount);
  const price = parseFloat(product.priceRange.minVariantPrice.amount);
  return compareAt > 0 && compareAt > price;
}

// ─── Types ───────────────────────────────────────────────────────

export interface Product {
  id: string;
  title: string;
  handle: string;
  description: string;
  descriptionHtml: string;
  createdAt: string;
  productType: string;
  category: {
    id: string;
    name: string;
    ancestors: Array<{ id: string; name: string }>;
  } | null;
  tags: string[];
  vendor: string;
  availableForSale: boolean;
  priceRange: {
    minVariantPrice: MoneyV2;
    maxVariantPrice: MoneyV2;
  };
  compareAtPriceRange: {
    minVariantPrice: MoneyV2;
  };
  images: {
    edges: Array<{ node: ShopifyImage }>;
  };
  variants: {
    edges: Array<{ node: ProductVariant }>;
  };
  media?: {
    edges: Array<{ node: ProductMedia }>;
  };
  seo: {
    title: string;
    description: string;
  };
}

export interface ProductVariant {
  id: string;
  title: string;
  availableForSale: boolean;
  quantityAvailable: number | null;
  price: MoneyV2;
  compareAtPrice: MoneyV2 | null;
  selectedOptions: Array<{ name: string; value: string }>;
  image: ShopifyImage | null;
}

export interface ProductMedia {
  mediaContentType: 'IMAGE' | 'VIDEO' | 'EXTERNAL_VIDEO' | 'MODEL_3D';
  id?: string;
  sources?: Array<{ url: string; mimeType: string }>;
  previewImage?: { url: string };
  host?: string;
  embeddedUrl?: string;
}

export interface Collection {
  id: string;
  title: string;
  handle: string;
  description: string;
  image: ShopifyImage | null;
  products: {
    edges: Array<{ node: Product }>;
  };
}

export interface Cart {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  cost: {
    totalAmount: MoneyV2;
  };
  lines?: {
    edges: Array<{
      node: {
        id: string;
        quantity: number;
        merchandise: ProductVariant & { product: Product };
      };
    }>;
  };
}

export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

export interface ShopifyImage {
  url: string;
  altText: string | null;
  width?: number;
  height?: number;
}
