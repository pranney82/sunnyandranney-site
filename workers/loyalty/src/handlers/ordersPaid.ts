import type { Env } from '../env';
import { getCustomerLoyaltyState, setMetafields, logTransaction } from '../lib/shopify';
import { computeTier } from '../lib/tiers';
import { fireFlowTrigger } from '../lib/flow';

interface OrderPayload {
  id: number;
  admin_graphql_api_id: string;
  customer: { id: number; admin_graphql_api_id: string } | null;
  subtotal_price: string;  // e.g. "120.00"
  total_discounts: string;
  note_attributes?: Array<{ name: string; value: string }>;
}

export async function handleOrdersPaid(env: Env, order: OrderPayload): Promise<void> {
  // Walk-in POS without a customer attached — skip silently.
  if (!order.customer) return;

  const customerId = order.customer.admin_graphql_api_id;
  const orderId = order.admin_graphql_api_id;

  // Earn base: subtotal_price already excludes shipping and tax.
  // We do NOT subtract loyalty redemption from the earn base — earning on post-redemption
  // amount is intentional per project decision.
  const subtotal = parseFloat(order.subtotal_price);
  if (isNaN(subtotal) || subtotal <= 0) return;

  const state = await getCustomerLoyaltyState(env, customerId);
  const tier = computeTier(state.lifetimeEarned);

  const earnedRaw = Math.floor(subtotal * tier.multiplier);

  // Check for loyalty redemption flag from cart/POS
  const redeemAttr = order.note_attributes?.find(
    (a) => a.name === 'loyalty_redeem_points',
  );
  const redeemed = redeemAttr ? parseInt(redeemAttr.value, 10) || 0 : 0;
  const rewardTypeAttr = order.note_attributes?.find(
    (a) => a.name === 'loyalty_reward_type',
  );
  const rewardType = rewardTypeAttr?.value ?? 'fixed_amount';

  // New balances
  const newPoints = state.points + earnedRaw - redeemed;
  const newLifetime = state.lifetimeEarned + earnedRaw;
  const newTier = computeTier(newLifetime);

  // Atomic update via compareDigest (prevents lost updates on concurrent webhooks).
  const updates = [
    {
      ownerId: customerId,
      namespace: '$app:loyalty',
      key: 'points',
      type: 'number_integer',
      value: String(newPoints),
      compareDigest: state.pointsDigest,
    },
    {
      ownerId: customerId,
      namespace: '$app:loyalty',
      key: 'lifetime_earned',
      type: 'number_integer',
      value: String(newLifetime),
      compareDigest: state.lifetimeEarnedDigest,
    },
  ];

  if (newTier.name !== state.vipTier) {
    updates.push({
      ownerId: customerId,
      namespace: '$app:loyalty',
      key: 'vip_tier',
      type: 'single_line_text_field',
      value: newTier.name,
      compareDigest: state.vipTierDigest,
    });
  }

  await setMetafields(env, updates);

  // Log earn transaction. If redemption also happened, log separately for audit clarity.
  await logTransaction(env, {
    customerId,
    type: 'earn',
    amount: earnedRaw,
    orderId,
    balanceAfter: state.points + earnedRaw,  // pre-redemption balance
    notes: `Tier ${tier.name} (${tier.multiplier}x) on $${subtotal.toFixed(2)} subtotal`,
  });

  if (redeemed > 0) {
    await logTransaction(env, {
      customerId,
      type: 'redeem',
      amount: -redeemed,
      orderId,
      balanceAfter: newPoints,
    });
  }

  // Flow triggers — power Shopify Email notifications. Fire-and-forget.
  if (earnedRaw > 0) {
    await fireFlowTrigger(env, 'loyalty-points-earned', {
      customer_id: customerId,
      order_id: orderId,
      pointsEarned: earnedRaw,
      newBalance: newPoints,
      tierName: newTier.name,
    });
  }
  if (newTier.name !== state.vipTier) {
    await fireFlowTrigger(env, 'loyalty-tier-upgraded', {
      customer_id: customerId,
      previousTier: state.vipTier,
      newTier: newTier.name,
      lifetimeEarned: newLifetime,
    });
  }
  if (redeemed > 0) {
    await fireFlowTrigger(env, 'loyalty-points-redeemed', {
      customer_id: customerId,
      order_id: orderId,
      pointsRedeemed: redeemed,
      rewardType: rewardType,
      newBalance: newPoints,
    });
  }
}
