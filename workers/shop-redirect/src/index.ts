// Worker bound to shop.sunnyandranney.com/*. Issues server-side 301s to the
// custom storefront at sunnyandranney.com, except for cart/checkout paths
// which redirect to the Shopify-hosted .myshopify.com domain so in-flight
// carts continue to complete checkout.

const STOREFRONT_ORIGIN = "https://sunnyandranney.com";
const SHOPIFY_CHECKOUT_ORIGIN = "https://sunnyandranney.myshopify.com";

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

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = new URL(
      url.pathname + url.search + url.hash,
      shouldRouteToShopify(url.pathname) ? SHOPIFY_CHECKOUT_ORIGIN : STOREFRONT_ORIGIN,
    );

    return new Response(null, {
      status: 301,
      headers: {
        Location: target.toString(),
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
