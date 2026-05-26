import type { Env } from '../env';
import { adminGraphQL } from '../lib/shopify';

interface ShopifyFunctionNode {
  id: string;
  apiType: string;
  title: string;
  app: { title: string };
}

interface AutomaticAppDiscount {
  discountId: string;
  title: string;
  status: string;
}

// One-shot endpoint that locates the loyalty redemption function and
// creates an automatic app discount for it. If an existing "Loyalty Redemption"
// discount is found, it's updated in place (handy for Phase D, which expanded
// the discount classes from [ORDER] to [ORDER, PRODUCT, SHIPPING]).
export async function handleCreateRedemptionDiscount(env: Env): Promise<Response> {
  const existing = await findExistingDiscount(env, 'Loyalty Redemption');
  if (existing) {
    const updated = await updateDiscountClasses(env, existing.id);
    return Response.json({ status: 'updated', discount: updated });
  }

  const fnData = await adminGraphQL<{
    shopifyFunctions: { nodes: ShopifyFunctionNode[] };
  }>(
    env,
    `query { shopifyFunctions(first: 50) { nodes { id apiType title app { title } } } }`,
  );

  const fn = fnData.shopifyFunctions.nodes.find(
    (n) => n.apiType === 'discount' && /loyalty/i.test(n.title),
  );
  if (!fn) {
    return Response.json(
      {
        error: 'function not found',
        availableFunctions: fnData.shopifyFunctions.nodes,
      },
      { status: 404 },
    );
  }

  const mut = await adminGraphQL<{
    discountAutomaticAppCreate: {
      automaticAppDiscount: AutomaticAppDiscount | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    env,
    `mutation($input: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $input) {
        automaticAppDiscount { discountId title status }
        userErrors { field message }
      }
    }`,
    {
      input: {
        functionId: fn.id,
        title: 'Loyalty Redemption',
        startsAt: new Date().toISOString(),
        // Function emits any of these classes depending on the reward type
        // the customer selects (Phase D: fixed_amount, percentage, free_product, free_shipping).
        discountClasses: ['ORDER', 'PRODUCT', 'SHIPPING'],
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: true,
          shippingDiscounts: true,
        },
      },
    },
  );

  if (mut.discountAutomaticAppCreate.userErrors.length > 0) {
    return Response.json(
      {
        error: 'discountAutomaticAppCreate failed',
        userErrors: mut.discountAutomaticAppCreate.userErrors,
      },
      { status: 500 },
    );
  }

  return Response.json({
    status: 'created',
    discount: mut.discountAutomaticAppCreate.automaticAppDiscount,
    functionUsed: { id: fn.id, title: fn.title, app: fn.app.title },
  });
}

async function updateDiscountClasses(
  env: Env,
  discountId: string,
): Promise<{ id: string; title: string; status: string; discountClasses: string[] }> {
  const data = await adminGraphQL<{
    discountAutomaticAppUpdate: {
      automaticAppDiscount: {
        discountId: string;
        title: string;
        status: string;
        discountClasses: string[];
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    env,
    `mutation($id: ID!, $input: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $input) {
        automaticAppDiscount { discountId title status discountClasses }
        userErrors { field message }
      }
    }`,
    {
      id: discountId,
      input: {
        discountClasses: ['ORDER', 'PRODUCT', 'SHIPPING'],
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: true,
          shippingDiscounts: true,
        },
      },
    },
  );

  if (data.discountAutomaticAppUpdate.userErrors.length > 0) {
    throw new Error(
      `discountAutomaticAppUpdate failed: ${data.discountAutomaticAppUpdate.userErrors
        .map((e) => `${e.field.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }
  const updated = data.discountAutomaticAppUpdate.automaticAppDiscount;
  if (!updated) {
    throw new Error('discountAutomaticAppUpdate returned no discount');
  }
  return {
    id: updated.discountId,
    title: updated.title,
    status: updated.status,
    discountClasses: updated.discountClasses,
  };
}

async function findExistingDiscount(
  env: Env,
  title: string,
): Promise<{ id: string; title: string; status: string } | null> {
  const data = await adminGraphQL<{
    automaticDiscountNodes: {
      nodes: Array<{
        id: string;
        automaticDiscount: { __typename: string; title?: string; status?: string };
      }>;
    };
  }>(
    env,
    `query {
      automaticDiscountNodes(first: 50) {
        nodes {
          id
          automaticDiscount {
            __typename
            ... on DiscountAutomaticApp { title status }
          }
        }
      }
    }`,
  );

  const match = data.automaticDiscountNodes.nodes.find(
    (n) =>
      n.automaticDiscount.__typename === 'DiscountAutomaticApp' &&
      n.automaticDiscount.title === title,
  );
  if (!match || !match.automaticDiscount.title) return null;
  return {
    id: match.id,
    title: match.automaticDiscount.title,
    status: match.automaticDiscount.status ?? 'UNKNOWN',
  };
}
