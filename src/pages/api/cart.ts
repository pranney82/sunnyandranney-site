import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const SHOPIFY_API_VERSION = '2025-01';

const CART_FRAGMENT = `
  fragment CartFields on Cart {
    id
    checkoutUrl
    totalQuantity
    cost {
      totalAmount { amount currencyCode }
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
              availableForSale
              price { amount }
              product {
                title
                handle
                images(first: 1) { edges { node { url } } }
              }
            }
          }
        }
      }
    }
  }
`;

const OPERATIONS = {
  cartCreate: `
    ${CART_FRAGMENT}
    mutation CartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `,
  cartLinesAdd: `
    ${CART_FRAGMENT}
    mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `,
  cartLinesUpdate: `
    ${CART_FRAGMENT}
    mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
      cartLinesUpdate(cartId: $cartId, lines: $lines) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `,
  cartLinesRemove: `
    ${CART_FRAGMENT}
    mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
        cart { ...CartFields }
        userErrors { field message }
      }
    }
  `,
  cartFetch: `
    ${CART_FRAGMENT}
    query GetCart($cartId: ID!) {
      cart(id: $cartId) { ...CartFields }
    }
  `,
} as const;

type Operation = keyof typeof OPERATIONS;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const POST: APIRoute = async ({ request }) => {
  let body: { operation?: string; variables?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ errors: [{ message: 'Invalid JSON body' }] }), { status: 400, headers: JSON_HEADERS });
  }

  const operation = body.operation as Operation | undefined;
  if (!operation || !(operation in OPERATIONS)) {
    return new Response(
      JSON.stringify({ errors: [{ message: `Unknown operation: ${operation}` }] }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const domain = env.SHOPIFY_STORE_DOMAIN || env.PUBLIC_SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_TOKEN || env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN;
  if (!domain || !token) {
    return new Response(
      JSON.stringify({ errors: [{ message: 'Shopify Storefront credentials not configured' }] }),
      { status: 500, headers: JSON_HEADERS }
    );
  }

  const query = OPERATIONS[operation];
  const variables = body.variables ?? {};

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://${domain}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Shopify ${res.status}`);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }

      const payload = await res.text();
      return new Response(payload, { status: 200, headers: JSON_HEADERS });
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }

  console.error('[api/cart] Shopify proxy failed:', lastError);
  return new Response(
    JSON.stringify({ errors: [{ message: 'Upstream Shopify request failed' }] }),
    { status: 502, headers: JSON_HEADERS }
  );
};
