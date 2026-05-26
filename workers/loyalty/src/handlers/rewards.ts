import type { Env } from '../env';
import { adminGraphQL } from '../lib/shopify';

interface RewardFields {
  name: string;
  pointCost: number;
  rewardType: 'fixed_amount' | 'percentage' | 'free_product' | 'free_shipping';
  value: number;
  eligibleVariantId: string | null;
}

export interface LoyaltyReward extends RewardFields {
  id: string;
  handle: string;
}

const LIST_REWARDS_QUERY = `
  query ListRewards {
    metaobjects(type: "$app:loyalty_reward", first: 50) {
      nodes {
        id
        handle
        name: field(key: "name") { value }
        pointCost: field(key: "point_cost") { value }
        rewardType: field(key: "reward_type") { value }
        value: field(key: "value") { value }
        eligibleVariant: field(key: "eligible_variant") {
          reference { ... on ProductVariant { id } }
        }
      }
    }
  }
`;

const GET_REWARD_QUERY = `
  query GetReward($id: ID!) {
    metaobject(id: $id) {
      id
      handle
      type
      name: field(key: "name") { value }
      pointCost: field(key: "point_cost") { value }
      rewardType: field(key: "reward_type") { value }
      value: field(key: "value") { value }
      eligibleVariant: field(key: "eligible_variant") {
        reference { ... on ProductVariant { id } }
      }
    }
  }
`;

type RewardNode = {
  id: string;
  handle: string;
  name: { value: string };
  pointCost: { value: string };
  rewardType: { value: string };
  value: { value: string };
  eligibleVariant: { reference: { id: string } | null } | null;
};

function parseReward(node: RewardNode): LoyaltyReward {
  return {
    id: node.id,
    handle: node.handle,
    name: node.name.value,
    pointCost: parseInt(node.pointCost.value, 10),
    rewardType: node.rewardType.value as RewardFields['rewardType'],
    value: parseFloat(node.value.value),
    eligibleVariantId: node.eligibleVariant?.reference?.id ?? null,
  };
}

export async function handleListRewards(env: Env): Promise<Response> {
  const data = await adminGraphQL<{ metaobjects: { nodes: RewardNode[] } }>(
    env,
    LIST_REWARDS_QUERY,
  );
  const rewards = data.metaobjects.nodes
    .map(parseReward)
    .sort((a, b) => a.pointCost - b.pointCost);
  return new Response(JSON.stringify({ rewards }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function handleGetReward(env: Env, id: string): Promise<Response> {
  const data = await adminGraphQL<{ metaobject: (RewardNode & { type: string }) | null }>(
    env,
    GET_REWARD_QUERY,
    { id },
  );
  if (!data.metaobject) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json({ reward: parseReward(data.metaobject) });
}

// One-shot seed of starter rewards. Idempotent on handle.
const STARTER_REWARDS: Array<{
  handle: string;
  fields: Array<{ key: string; value: string }>;
}> = [
  {
    handle: 'reward-100-dollar-off',
    fields: [
      { key: 'name', value: '$1 off' },
      { key: 'point_cost', value: '100' },
      { key: 'reward_type', value: 'fixed_amount' },
      { key: 'value', value: '1' },
    ],
  },
  {
    handle: 'reward-500-five-dollars',
    fields: [
      { key: 'name', value: '$5 off' },
      { key: 'point_cost', value: '500' },
      { key: 'reward_type', value: 'fixed_amount' },
      { key: 'value', value: '5' },
    ],
  },
  {
    handle: 'reward-1000-ten-dollars',
    fields: [
      { key: 'name', value: '$10 off' },
      { key: 'point_cost', value: '1000' },
      { key: 'reward_type', value: 'fixed_amount' },
      { key: 'value', value: '10' },
    ],
  },
  {
    handle: 'reward-2500-twentyfive-dollars',
    fields: [
      { key: 'name', value: '$25 off' },
      { key: 'point_cost', value: '2500' },
      { key: 'reward_type', value: 'fixed_amount' },
      { key: 'value', value: '25' },
    ],
  },
  {
    handle: 'reward-1500-ten-percent',
    fields: [
      { key: 'name', value: '10% off order' },
      { key: 'point_cost', value: '1500' },
      { key: 'reward_type', value: 'percentage' },
      { key: 'value', value: '10' },
    ],
  },
  {
    handle: 'reward-3000-free-shipping',
    fields: [
      { key: 'name', value: 'Free shipping' },
      { key: 'point_cost', value: '3000' },
      { key: 'reward_type', value: 'free_shipping' },
      { key: 'value', value: '1' },
    ],
  },
];

const UPSERT_METAOBJECT = `
  mutation Upsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

export async function handleSeedRewards(env: Env): Promise<Response> {
  const created: Array<{ handle: string; id: string }> = [];
  const errors: Array<{ handle: string; messages: string[] }> = [];

  for (const r of STARTER_REWARDS) {
    const data = await adminGraphQL<{
      metaobjectUpsert: {
        metaobject: { id: string; handle: string } | null;
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    }>(env, UPSERT_METAOBJECT, {
      handle: { type: '$app:loyalty_reward', handle: r.handle },
      metaobject: { fields: r.fields },
    });

    if (data.metaobjectUpsert.userErrors.length > 0) {
      errors.push({
        handle: r.handle,
        messages: data.metaobjectUpsert.userErrors.map((e) => e.message),
      });
    } else if (data.metaobjectUpsert.metaobject) {
      created.push(data.metaobjectUpsert.metaobject);
    }
  }

  return Response.json({ created, errors });
}
