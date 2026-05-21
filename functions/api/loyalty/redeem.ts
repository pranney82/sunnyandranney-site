import { getSession, readCookie } from '../../_lib/session';

interface Env {
  SESSION_SECRET: string;
  SHOPIFY_STORE_DOMAIN?: string;
  PUBLIC_SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_STOREFRONT_TOKEN?: string;
  PUBLIC_SHOPIFY_STOREFRONT_TOKEN?: string;
  LOYALTY_WORKER_URL?: string;
}

const CART_ID_COOKIE = 'sr_cart_id';
const STOREFRONT_API_VERSION = '2025-01';
const DEFAULT_LOYALTY_WORKER = 'https://loyalty.soard.workers.dev';

interface Reward {
  id: string;
  handle: string;
  name: string;
  pointCost: number;
  rewardType: 'fixed_amount' | 'percentage' | 'free_product' | 'free_shipping';
  value: number;
  eligibleVariantId: string | null;
}

const CART_ATTRIBUTES_UPDATE = /* GraphQL */ `
  mutation CartAttributesUpdate($cartId: ID!, $attributes: [AttributeInput!]!) {
    cartAttributesUpdate(cartId: $cartId, attributes: $attributes) {
      cart { id checkoutUrl totalQuantity }
      userErrors { field message }
    }
  }
`;

interface RedeemBody {
  rewardId?: unknown;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // 1. Auth
  const session = await getSession(request, env.SESSION_SECRET);
  if (!session) {
    return Response.json({ error: 'not_authenticated' }, { status: 401 });
  }

  // 2. Parse body
  let body: RedeemBody;
  try {
    body = (await request.json()) as RedeemBody;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const rewardId = typeof body.rewardId === 'string' ? body.rewardId : null;
  if (!rewardId || !rewardId.startsWith('gid://shopify/Metaobject/')) {
    return Response.json({ error: 'invalid_reward_id' }, { status: 400 });
  }

  // 3. Look up the reward
  const workerBase = env.LOYALTY_WORKER_URL ?? DEFAULT_LOYALTY_WORKER;
  const rewardRes = await fetch(
    `${workerBase}/api/reward?id=${encodeURIComponent(rewardId)}`,
  );
  if (rewardRes.status === 404) {
    return Response.json({ error: 'reward_not_found' }, { status: 404 });
  }
  if (!rewardRes.ok) {
    return Response.json(
      { error: 'reward_lookup_failed', upstreamStatus: rewardRes.status },
      { status: 502 },
    );
  }
  const rewardJson = (await rewardRes.json()) as { reward: Reward };
  const reward = rewardJson.reward;

  // 4. Confirm balance
  const balRes = await fetch(
    `${workerBase}/api/customer/balance?customer_id=${encodeURIComponent(session.customerId)}`,
  );
  if (!balRes.ok) {
    return Response.json(
      { error: 'balance_lookup_failed', upstreamStatus: balRes.status },
      { status: 502 },
    );
  }
  const balance = (await balRes.json()) as { points: number };
  if (balance.points < reward.pointCost) {
    return Response.json(
      { error: 'insufficient_points', available: balance.points, required: reward.pointCost },
      { status: 400 },
    );
  }

  // 5. free_product reward requires the eligible variant to actually be in cart;
  // we leave that check to the Discount Function at checkout time (it returns no
  // operation if the variant isn't present), but we still need a cart.
  const cartId = readCookie(request.headers.get('Cookie'), CART_ID_COOKIE);
  if (!cartId) {
    return Response.json(
      { error: 'no_cart', message: 'Add items to your cart before redeeming.' },
      { status: 400 },
    );
  }

  // 6. Set cart attributes
  const domain = env.SHOPIFY_STORE_DOMAIN ?? env.PUBLIC_SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_TOKEN ?? env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN;
  if (!domain || !token) {
    return Response.json({ error: 'storefront_not_configured' }, { status: 500 });
  }

  const attributes: Array<{ key: string; value: string }> = [
    { key: 'loyalty_reward_id', value: reward.id },
    { key: 'loyalty_reward_type', value: reward.rewardType },
    { key: 'loyalty_reward_value', value: String(reward.value) },
    { key: 'loyalty_redeem_points', value: String(reward.pointCost) },
  ];
  if (reward.eligibleVariantId) {
    attributes.push({ key: 'loyalty_reward_variant_id', value: reward.eligibleVariantId });
  }

  const sfRes = await fetch(`https://${domain}/api/${STOREFRONT_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({
      query: CART_ATTRIBUTES_UPDATE,
      variables: { cartId, attributes },
    }),
  });

  const sfJson = (await sfRes.json()) as {
    data?: {
      cartAttributesUpdate?: {
        cart: { id: string; checkoutUrl: string; totalQuantity: number } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (sfJson.errors && sfJson.errors.length > 0) {
    return Response.json(
      { error: 'storefront_error', detail: sfJson.errors.map((e) => e.message).join('; ') },
      { status: 502 },
    );
  }

  const result = sfJson.data?.cartAttributesUpdate;
  if (!result || result.userErrors.length > 0) {
    return Response.json(
      { error: 'cart_update_failed', userErrors: result?.userErrors ?? [] },
      { status: 400 },
    );
  }
  if (!result.cart) {
    return Response.json({ error: 'cart_not_found' }, { status: 404 });
  }

  return Response.json({
    status: 'ok',
    checkoutUrl: result.cart.checkoutUrl,
    reward: {
      id: reward.id,
      name: reward.name,
      pointCost: reward.pointCost,
      rewardType: reward.rewardType,
      value: reward.value,
    },
  });
};
