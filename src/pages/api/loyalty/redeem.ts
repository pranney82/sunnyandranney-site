import type { APIRoute } from 'astro';
import { getSession, readCookie } from '@/lib/auth/session';

export const prerender = false;

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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string | undefined> } }).runtime?.env
    ?? (process.env as Record<string, string | undefined>);

  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) return json({ error: 'auth not configured' }, 500);

  // 1. Auth
  const session = await getSession(request, sessionSecret);
  if (!session) return json({ error: 'not_authenticated' }, 401);

  // 2. Parse body
  let body: RedeemBody;
  try {
    body = (await request.json()) as RedeemBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const rewardId = typeof body.rewardId === 'string' ? body.rewardId : null;
  if (!rewardId || !rewardId.startsWith('gid://shopify/Metaobject/')) {
    return json({ error: 'invalid_reward_id' }, 400);
  }

  // 3. Look up the reward via the loyalty Worker
  const workerBase = env.LOYALTY_WORKER_URL ?? DEFAULT_LOYALTY_WORKER;
  const rewardRes = await fetch(
    `${workerBase}/api/reward?id=${encodeURIComponent(rewardId)}`,
  );
  if (rewardRes.status === 404) return json({ error: 'reward_not_found' }, 404);
  if (!rewardRes.ok) {
    return json({ error: 'reward_lookup_failed', upstreamStatus: rewardRes.status }, 502);
  }
  const rewardJson = (await rewardRes.json()) as { reward: Reward };
  const reward = rewardJson.reward;

  // 4. Confirm balance
  const balRes = await fetch(
    `${workerBase}/api/customer/balance?customer_id=${encodeURIComponent(session.customerId)}`,
  );
  if (!balRes.ok) {
    return json({ error: 'balance_lookup_failed', upstreamStatus: balRes.status }, 502);
  }
  const balance = (await balRes.json()) as { points: number };
  if (balance.points < reward.pointCost) {
    return json(
      { error: 'insufficient_points', available: balance.points, required: reward.pointCost },
      400,
    );
  }

  // 5. Need an existing cart to attach the attribute to
  const cartId = readCookie(request.headers.get('Cookie'), CART_ID_COOKIE);
  if (!cartId) {
    return json({ error: 'no_cart', message: 'Add items to your cart before redeeming.' }, 400);
  }

  // 6. Set cart attributes via Storefront API
  const domain = env.SHOPIFY_STORE_DOMAIN ?? env.PUBLIC_SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_STOREFRONT_TOKEN ?? env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN;
  if (!domain || !token) {
    return json({ error: 'storefront_not_configured' }, 500);
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
    return json(
      { error: 'storefront_error', detail: sfJson.errors.map((e) => e.message).join('; ') },
      502,
    );
  }

  const result = sfJson.data?.cartAttributesUpdate;
  if (!result || result.userErrors.length > 0) {
    return json({ error: 'cart_update_failed', userErrors: result?.userErrors ?? [] }, 400);
  }
  if (!result.cart) {
    return json({ error: 'cart_not_found' }, 404);
  }

  return json(
    {
      status: 'ok',
      checkoutUrl: result.cart.checkoutUrl,
      reward: {
        id: reward.id,
        name: reward.name,
        pointCost: reward.pointCost,
        rewardType: reward.rewardType,
        value: reward.value,
      },
    },
    200,
  );
};
