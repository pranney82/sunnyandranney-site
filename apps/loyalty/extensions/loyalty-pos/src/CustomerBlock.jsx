import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const LOYALTY_BASE = 'https://loyalty.soard.workers.dev';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const customerId = shopify.customer?.id;
  const [state, setState] = useState({ kind: 'loading' });
  const [busyReward, setBusyReward] = useState(null);

  useEffect(() => {
    if (!customerId) {
      setState({ kind: 'no_customer' });
      return;
    }
    setState({ kind: 'loading' });
    Promise.all([fetchBalance(customerId), fetchRewards()])
      .then(([bal, rewards]) => setState({ kind: 'loaded', bal, rewards }))
      .catch((err) => {
        console.error('[loyalty-pos] block load failed', err);
        setState({ kind: 'error' });
      });
  }, [customerId]);

  return (
    <s-pos-block>
      <s-text variant="strong">Loyalty rewards</s-text>
      {renderBody({ state, busyReward, setBusyReward, setState })}
    </s-pos-block>
  );
}

function renderBody({ state, busyReward, setBusyReward, setState }) {
  if (state.kind === 'no_customer') {
    return <s-text>No customer selected.</s-text>;
  }
  if (state.kind === 'loading') {
    return <s-text>Loading…</s-text>;
  }
  if (state.kind === 'error') {
    return <s-text>Could not load loyalty data.</s-text>;
  }

  const { bal, rewards } = state;
  const posCompatibleRewards = rewards.filter(
    (r) => r.rewardType === 'fixed_amount' || r.rewardType === 'percentage',
  );

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="large">
        <s-stack direction="block">
          <s-text>Points</s-text>
          <s-text variant="strong">{bal.points.toLocaleString('en-US')}</s-text>
        </s-stack>
        <s-stack direction="block">
          <s-text>Lifetime</s-text>
          <s-text>{bal.lifetime_earned.toLocaleString('en-US')}</s-text>
        </s-stack>
        <s-stack direction="block">
          <s-text>Tier</s-text>
          <s-text variant="strong">{bal.vip_tier}</s-text>
        </s-stack>
      </s-stack>

      <s-text variant="strong">Redeem (applies to current cart)</s-text>
      <s-stack direction="block" gap="small">
        {posCompatibleRewards.length === 0 ? (
          <s-text>No POS rewards available.</s-text>
        ) : (
          posCompatibleRewards.map((reward) => {
            const affordable = bal.points >= reward.pointCost;
            const isBusy = busyReward === reward.id;
            return (
              <s-button
                key={reward.id}
                variant="primary"
                disabled={!affordable || busyReward !== null}
                onClick={async () => {
                  await applyRedemption({ reward, setBusyReward, setState, bal, rewards });
                }}
              >
                {`${reward.name} · ${reward.pointCost.toLocaleString('en-US')} pts`}
              </s-button>
            );
          })
        )}
      </s-stack>
    </s-stack>
  );
}

async function applyRedemption({ reward, setBusyReward, setState, bal, rewards }) {
  setBusyReward(reward.id);
  try {
    // The cart must have a customer attached for discount/properties to apply.
    const currentCart = shopify.cart.current?.value;
    if (!currentCart?.customer?.id) {
      shopify.toast?.show?.('Attach this customer to the cart first.', { type: 'error' });
      return;
    }

    if (reward.rewardType === 'fixed_amount') {
      await shopify.cart.applyCartDiscount(
        'FixedAmount',
        `Loyalty: ${reward.name}`,
        String(reward.value.toFixed(2)),
      );
    } else if (reward.rewardType === 'percentage') {
      await shopify.cart.applyCartDiscount(
        'Percentage',
        `Loyalty: ${reward.name}`,
        String(reward.value),
      );
    }

    await shopify.cart.addCartProperties({
      loyalty_reward_id: reward.id,
      loyalty_reward_type: reward.rewardType,
      loyalty_reward_value: String(reward.value),
      loyalty_redeem_points: String(reward.pointCost),
    });

    shopify.toast?.show?.(`${reward.name} applied`);
    setState({
      kind: 'loaded',
      bal: { ...bal, points: bal.points - reward.pointCost },
      rewards,
    });
  } catch (err) {
    console.error('[loyalty-pos] block redemption failed', err);
    const msg = err instanceof Error ? err.message : String(err);
    shopify.toast?.show?.(`Redeem failed: ${msg.slice(0, 100)}`, { type: 'error' });
  } finally {
    setBusyReward(null);
  }
}

async function fetchBalance(customerId) {
  const gid = normalizeCustomerGid(customerId);
  const res = await fetch(
    `${LOYALTY_BASE}/api/customer/balance?customer_id=${encodeURIComponent(gid)}`,
  );
  if (!res.ok) throw new Error(`balance ${res.status}`);
  return res.json();
}

async function fetchRewards() {
  const res = await fetch(`${LOYALTY_BASE}/api/rewards`);
  if (!res.ok) throw new Error(`rewards ${res.status}`);
  const { rewards } = await res.json();
  return rewards;
}

function normalizeCustomerGid(id) {
  if (typeof id === 'string' && id.startsWith('gid://shopify/Customer/')) return id;
  return `gid://shopify/Customer/${id}`;
}
