import type { Env } from '../env';
import { adminGraphQL, getCustomerLoyaltyState, setMetafields, logTransaction } from '../lib/shopify';

interface RefundPayload {
  id: number;
  order_id: number;
  refund_line_items?: Array<{ subtotal: string }>;
}

interface OrderDetails {
  id: string;
  customer: { id: string } | null;
  subtotalPriceSet: { shopMoney: { amount: string } };
  noteAttributes: Array<{ name: string; value: string }>;
}

async function fetchOrder(env: Env, orderId: number): Promise<OrderDetails | null> {
  const data = await adminGraphQL<{ order: OrderDetails | null }>(
    env,
    `query($id: ID!) {
      order(id: $id) {
        id
        customer { id }
        subtotalPriceSet { shopMoney { amount } }
        noteAttributes: customAttributes { name: key value }
      }
    }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  return data.order;
}

export async function handleRefundsCreate(env: Env, refund: RefundPayload): Promise<void> {
  const order = await fetchOrder(env, refund.order_id);
  if (!order || !order.customer) return;

  const customerId = order.customer.id;
  const originalSubtotal = parseFloat(order.subtotalPriceSet.shopMoney.amount);
  if (originalSubtotal <= 0) return;

  // Sum refund line subtotals
  const refundedAmount = (refund.refund_line_items ?? []).reduce(
    (sum, li) => sum + parseFloat(li.subtotal),
    0,
  );
  if (refundedAmount <= 0) return;

  const state = await getCustomerLoyaltyState(env, customerId);

  // Proportional clawback. We re-derive points-earned-on-this-order from the order's tier-at-time-of-earn.
  // Conservative approach: clawback assumes the tier multiplier at earn time matches current state.
  // For perfect accuracy we'd query the loyalty_transaction metaobject for this order; v1 keeps it simple.
  const refundRatio = Math.min(1, refundedAmount / originalSubtotal);
  const earnedOnOrder = Math.floor(originalSubtotal * 1.0);  // Bronze baseline; loyalty_transaction lookup would be exact
  const clawbackEarn = Math.floor(earnedOnOrder * refundRatio);

  // Restore redemption proportionally if order included one
  const redeemAttr = order.noteAttributes.find((a) => a.name === 'loyalty_redeem_points');
  const redeemedOnOrder = redeemAttr ? parseInt(redeemAttr.value, 10) || 0 : 0;
  const restoreRedeem = Math.floor(redeemedOnOrder * refundRatio);

  const newPoints = state.points - clawbackEarn + restoreRedeem;
  const newLifetime = Math.max(0, state.lifetimeEarned - clawbackEarn);

  await setMetafields(env, [
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
  ]);

  await logTransaction(env, {
    customerId,
    type: 'refund',
    amount: -clawbackEarn + restoreRedeem,
    orderId: order.id,
    balanceAfter: newPoints,
    notes: `Refund ratio ${(refundRatio * 100).toFixed(1)}%: clawed ${clawbackEarn} earned, restored ${restoreRedeem} redeemed`,
  });
}
