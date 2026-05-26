import type { Env } from '../env';

interface GraphQLResponse<T> {
  data?: T;
  // Shopify returns errors as an array for query/mutation errors, but as a string
  // for transport-level errors (invalid token, 401 etc.). Normalize both.
  errors?: Array<{ message: string }> | string;
}

async function getAdminToken(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT access_token FROM loyalty_oauth_tokens WHERE shop_domain = ? ORDER BY installed_at DESC LIMIT 1',
  )
    .bind(env.SHOPIFY_STORE_DOMAIN)
    .first<{ access_token: string }>();
  return row?.access_token ?? env.SHOPIFY_ADMIN_TOKEN;
}

export async function adminGraphQL<T>(
  env: Env,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = await getAdminToken(env);
  const res = await fetch(
    `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors) {
    const msg = Array.isArray(json.errors)
      ? json.errors.map((e) => e.message).join('; ')
      : String(json.errors);
    throw new Error(`Shopify GraphQL [${res.status}]: ${msg}`);
  }
  if (!json.data) throw new Error(`Shopify GraphQL returned no data [${res.status}]`);
  return json.data;
}

interface CustomerLoyaltyState {
  id: string;
  points: number;
  pointsDigest: string | null;
  lifetimeEarned: number;
  lifetimeEarnedDigest: string | null;
  vipTier: string;
  vipTierDigest: string | null;
}

export async function getCustomerLoyaltyState(
  env: Env,
  customerId: string,
): Promise<CustomerLoyaltyState> {
  const data = await adminGraphQL<{
    customer: {
      id: string;
      points: { value: string | null; compareDigest: string | null } | null;
      lifetimeEarned: { value: string | null; compareDigest: string | null } | null;
      vipTier: { value: string | null; compareDigest: string | null } | null;
    } | null;
  }>(
    env,
    `query($id: ID!) {
      customer(id: $id) {
        id
        points: metafield(namespace: "$app:loyalty", key: "points") { value compareDigest }
        lifetimeEarned: metafield(namespace: "$app:loyalty", key: "lifetime_earned") { value compareDigest }
        vipTier: metafield(namespace: "$app:loyalty", key: "vip_tier") { value compareDigest }
      }
    }`,
    { id: customerId },
  );

  if (!data.customer) throw new Error(`Customer ${customerId} not found`);

  return {
    id: data.customer.id,
    points: data.customer.points?.value ? parseInt(data.customer.points.value, 10) : 0,
    pointsDigest: data.customer.points?.compareDigest ?? null,
    lifetimeEarned: data.customer.lifetimeEarned?.value
      ? parseInt(data.customer.lifetimeEarned.value, 10)
      : 0,
    lifetimeEarnedDigest: data.customer.lifetimeEarned?.compareDigest ?? null,
    vipTier: data.customer.vipTier?.value ?? 'Bronze',
    vipTierDigest: data.customer.vipTier?.compareDigest ?? null,
  };
}

interface MetafieldUpdate {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
  compareDigest?: string | null;
}

export async function setMetafields(env: Env, metafields: MetafieldUpdate[]): Promise<void> {
  const data = await adminGraphQL<{
    metafieldsSet: {
      metafields: Array<{ id: string }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    env,
    `mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      metafields: metafields.map((m) => ({
        ownerId: m.ownerId,
        namespace: m.namespace,
        key: m.key,
        type: m.type,
        value: m.value,
        ...(m.compareDigest ? { compareDigest: m.compareDigest } : {}),
      })),
    },
  );

  if (data.metafieldsSet.userErrors.length > 0) {
    throw new Error(
      `metafieldsSet errors: ${data.metafieldsSet.userErrors.map((e) => `${e.field.join('.')}: ${e.message}`).join('; ')}`,
    );
  }
}

interface LoyaltyTransactionInput {
  customerId: string;
  type: 'earn' | 'redeem' | 'refund' | 'expire' | 'adjust';
  amount: number;
  orderId?: string;
  balanceAfter: number;
  notes?: string;
}

export async function logTransaction(
  env: Env,
  tx: LoyaltyTransactionInput,
): Promise<void> {
  const data = await adminGraphQL<{
    metaobjectCreate: {
      metaobject: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    env,
    `mutation($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    {
      metaobject: {
        type: '$app:loyalty_transaction',
        fields: [
          { key: 'customer', value: tx.customerId },
          { key: 'type', value: tx.type },
          { key: 'amount', value: String(tx.amount) },
          ...(tx.orderId ? [{ key: 'order', value: tx.orderId }] : []),
          { key: 'balance_after', value: String(tx.balanceAfter) },
          { key: 'timestamp', value: new Date().toISOString() },
          ...(tx.notes ? [{ key: 'notes', value: tx.notes }] : []),
        ],
      },
    },
  );

  if (data.metaobjectCreate.userErrors.length > 0) {
    throw new Error(
      `loyalty_transaction create errors: ${data.metaobjectCreate.userErrors.map((e) => `${e.field.join('.')}: ${e.message}`).join('; ')}`,
    );
  }
}
