/**
 * Shopify Admin API Client
 * Uses the Admin GraphQL API for product management, inventory, and image uploads.
 * Mirrors the retry/fetch pattern from src/lib/shopify.ts (Storefront client).
 */
import { env } from 'cloudflare:workers';

const SHOPIFY_STORE_DOMAIN = import.meta.env.PUBLIC_SHOPIFY_STORE_DOMAIN || 'sunnyandranney.myshopify.com';
const ADMIN_API_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`;

interface AdminResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
  extensions?: { cost: { requestedQueryCost: number; actualQueryCost: number; throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } };
}

async function adminFetch<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error('SHOPIFY_ADMIN_TOKEN not configured');

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(ADMIN_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Shopify Admin API ${response.status}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      const json: AdminResponse<T> = await response.json();

      if (json.errors) {
        const isThrottled = json.errors.some(e => e.message.includes('Throttled'));
        if (isThrottled && attempt < 2) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        console.error('Shopify Admin API errors:', json.errors);
        throw new Error(json.errors.map(e => e.message).join(', '));
      }

      return json.data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < 2 && !lastError.message.includes('Shopify Admin API errors')) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('Shopify Admin fetch failed after retries');
}

// ─── Product Search ──────────────────────────────────────────

export interface AdminProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  images: { edges: Array<{ node: { url: string; altText: string | null } }> };
  variants: {
    edges: Array<{
      node: {
        id: string;
        sku: string;
        title: string;
        price: string;
        inventoryItem: { id: string };
        inventoryQuantity: number;
      };
    }>;
  };
}

export async function searchProducts(query: string, first = 10): Promise<AdminProduct[]> {
  const gql = `
    query SearchProducts($query: String!, $first: Int!) {
      products(first: $first, query: $query) {
        edges {
          node {
            id
            title
            handle
            status
            images(first: 1) {
              edges { node { url altText } }
            }
            variants(first: 5) {
              edges {
                node {
                  id
                  sku
                  title
                  price
                  inventoryItem { id }
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await adminFetch<{
    products: { edges: Array<{ node: AdminProduct }> };
  }>(gql, { query, first });

  return data.products.edges.map(e => e.node);
}

/** Search by SKU first, then fall back to title */
export async function findMatchingProduct(
  sku: string,
  title: string,
): Promise<{ product: AdminProduct; confidence: number } | null> {
  // Try SKU match first (high confidence)
  if (sku) {
    const skuResults = await searchProducts(`sku:${sku}`);
    if (skuResults.length > 0) {
      return { product: skuResults[0], confidence: 0.95 };
    }
  }

  // Fall back to title search (lower confidence)
  if (title) {
    const titleResults = await searchProducts(`title:${title}`);
    if (titleResults.length > 0) {
      // Check if title is a close match
      const normalizedSearch = title.toLowerCase().trim();
      const best = titleResults.find(p =>
        p.title.toLowerCase().trim() === normalizedSearch
      );
      if (best) return { product: best, confidence: 0.85 };

      // Partial match
      const partial = titleResults.find(p =>
        p.title.toLowerCase().includes(normalizedSearch) ||
        normalizedSearch.includes(p.title.toLowerCase())
      );
      if (partial) return { product: partial, confidence: 0.6 };

      // Return first result with low confidence
      return { product: titleResults[0], confidence: 0.3 };
    }
  }

  return null;
}

// ─── Product Creation ────────────────────────────────────────

export interface CreateProductInput {
  title: string;
  descriptionHtml?: string;
  productType?: string;
  vendor?: string;
  tags?: string[];
  variants?: Array<{
    price: string;
    sku?: string;
    inventoryManagement?: 'SHOPIFY' | 'NOT_MANAGED';
  }>;
}

export interface CreatedProduct {
  id: string;
  handle: string;
  variants: {
    edges: Array<{
      node: {
        id: string;
        inventoryItem: { id: string };
      };
    }>;
  };
}

export async function createProduct(input: CreateProductInput): Promise<CreatedProduct> {
  const gql = `
    mutation ProductCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          handle
          variants(first: 1) {
            edges {
              node {
                id
                inventoryItem { id }
              }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const productInput: Record<string, unknown> = {
    title: input.title,
    descriptionHtml: input.descriptionHtml || '',
    productType: input.productType || '',
    vendor: input.vendor || '',
    tags: input.tags || [],
  };

  if (input.variants?.length) {
    productInput.variants = input.variants.map(v => ({
      price: v.price,
      sku: v.sku || '',
      inventoryManagement: v.inventoryManagement || 'SHOPIFY',
    }));
  }

  const data = await adminFetch<{
    productCreate: {
      product: CreatedProduct | null;
      userErrors: Array<{ field: string; message: string }>;
    };
  }>(gql, { input: productInput });

  if (data.productCreate.userErrors.length > 0) {
    throw new Error(
      `Product creation failed: ${data.productCreate.userErrors.map(e => e.message).join(', ')}`
    );
  }

  if (!data.productCreate.product) {
    throw new Error('Product creation returned no product');
  }

  return data.productCreate.product;
}

// ─── Image Upload (Staged Uploads) ──────────────────────────

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

export async function createStagedUpload(
  filename: string,
  mimeType: string,
  fileSize: number,
): Promise<StagedTarget> {
  const gql = `
    mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await adminFetch<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: Array<{ field: string; message: string }>;
    };
  }>(gql, {
    input: [{
      filename,
      mimeType,
      httpMethod: 'POST',
      resource: 'IMAGE',
      fileSize: String(fileSize),
    }],
  });

  if (data.stagedUploadsCreate.userErrors.length > 0) {
    throw new Error(
      `Staged upload failed: ${data.stagedUploadsCreate.userErrors.map(e => e.message).join(', ')}`
    );
  }

  return data.stagedUploadsCreate.stagedTargets[0];
}

export async function uploadToStagedTarget(
  target: StagedTarget,
  fileBuffer: ArrayBuffer,
  mimeType: string,
): Promise<string> {
  const formData = new FormData();
  for (const param of target.parameters) {
    formData.append(param.name, param.value);
  }
  formData.append('file', new Blob([fileBuffer], { type: mimeType }));

  const response = await fetch(target.url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Staged upload HTTP ${response.status}`);
  }

  return target.resourceUrl;
}

export async function attachProductMedia(
  productId: string,
  resourceUrl: string,
  altText = '',
): Promise<void> {
  const gql = `
    mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id }
        mediaUserErrors { field message }
      }
    }
  `;

  const data = await adminFetch<{
    productCreateMedia: {
      media: Array<{ id: string }>;
      mediaUserErrors: Array<{ field: string; message: string }>;
    };
  }>(gql, {
    productId,
    media: [{
      originalSource: resourceUrl,
      alt: altText,
      mediaContentType: 'IMAGE',
    }],
  });

  if (data.productCreateMedia.mediaUserErrors.length > 0) {
    throw new Error(
      `Media attach failed: ${data.productCreateMedia.mediaUserErrors.map(e => e.message).join(', ')}`
    );
  }
}

// ─── Product Tags ────────────────────────────────────────────

export async function addTagsToProduct(productId: string, tags: string[]): Promise<void> {
  const gql = `
    mutation tagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;

  const data = await adminFetch<{
    tagsAdd: { userErrors: Array<{ field: string; message: string }> };
  }>(gql, { id: productId, tags });

  if (data.tagsAdd.userErrors.length > 0) {
    throw new Error(
      `Tags add failed: ${data.tagsAdd.userErrors.map(e => e.message).join(', ')}`
    );
  }
}

export async function removeTagsFromProduct(productId: string, tags: string[]): Promise<void> {
  const gql = `
    mutation tagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;

  const data = await adminFetch<{
    tagsRemove: { userErrors: Array<{ field: string; message: string }> };
  }>(gql, { id: productId, tags });

  if (data.tagsRemove.userErrors.length > 0) {
    throw new Error(
      `Tags remove failed: ${data.tagsRemove.userErrors.map(e => e.message).join(', ')}`
    );
  }
}

// ─── Inventory ───────────────────────────────────────────────

let cachedLocationId: string | null = null;

export async function getPrimaryLocationId(): Promise<string> {
  if (cachedLocationId) return cachedLocationId;

  const gql = `
    query {
      locations(first: 1) {
        edges { node { id } }
      }
    }
  `;

  const data = await adminFetch<{
    locations: { edges: Array<{ node: { id: string } }> };
  }>(gql);

  if (!data.locations.edges.length) {
    throw new Error('No Shopify locations found');
  }

  cachedLocationId = data.locations.edges[0].node.id;
  return cachedLocationId;
}

export async function adjustInventory(
  inventoryItemId: string,
  locationId: string,
  delta: number,
): Promise<void> {
  const gql = `
    mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        changes { name delta }
        userErrors { field message }
      }
    }
  `;

  const data = await adminFetch<{
    inventoryAdjustQuantities: {
      changes: Array<{ name: string; delta: number }>;
      userErrors: Array<{ field: string; message: string }>;
    };
  }>(gql, {
    input: {
      reason: 'received',
      name: 'available',
      changes: [{
        inventoryItemId,
        locationId,
        delta,
      }],
    },
  });

  if (data.inventoryAdjustQuantities.userErrors.length > 0) {
    throw new Error(
      `Inventory adjust failed: ${data.inventoryAdjustQuantities.userErrors.map(e => e.message).join(', ')}`
    );
  }
}
