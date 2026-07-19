// Worker bound to shop.sunnyandranney.com/*. Issues server-side 301s to the
// custom storefront at sunnyandranney.com, except for cart/checkout paths
// which redirect to the Shopify-hosted .myshopify.com domain so in-flight
// carts continue to complete checkout.

const STOREFRONT_ORIGIN = "https://sunnyandranney.com";
const SHOPIFY_CHECKOUT_ORIGIN = "https://store.sunnyandranney.com";

// Path prefixes that need to stay on Shopify so checkout can complete.
const SHOPIFY_PASSTHROUGH_PREFIXES = [
  "/cart/c/",
  "/cart/",
  "/checkouts/",
  "/checkout/",
  "/wallets/",
  "/account/",
  "/api/",
];

function shouldRouteToShopify(pathname: string): boolean {
  return SHOPIFY_PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p));
}

// Shopify uses /products/{handle}; the Astro storefront uses /shop/{handle}/.
// Rewrite the path when redirecting to the custom site so customers land on
// the real product page in a single 301 hop.
function rewritePathForStorefront(pathname: string): string {
  const productMatch = pathname.match(/^\/products\/([^/]+)\/?$/);
  if (productMatch) return `/shop/${productMatch[1]}/`;
  return pathname;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Collapse repeated slashes so a protocol-relative path like "//evil.com/x"
    // can't be resolved by the URL parser into an off-domain redirect target.
    const pathname = url.pathname.replace(/\/{2,}/g, "/");

    if (shouldRouteToShopify(pathname)) {
      const target = new URL(pathname + url.search + url.hash, SHOPIFY_CHECKOUT_ORIGIN);
      return new Response(null, {
        status: 301,
        headers: {
          Location: target.toString(),
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    const target = new URL(rewritePathForStorefront(pathname) + url.search + url.hash, STOREFRONT_ORIGIN);
    return new Response(null, {
      status: 301,
      headers: {
        Location: target.toString(),
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
