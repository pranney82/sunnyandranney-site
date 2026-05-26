import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const LOYALTY_BASE = 'https://loyalty.soard.workers.dev';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const [cart, setCart] = useState(null);
  const [state, setState] = useState({ kind: 'idle' });
  const [busyReward, setBusyReward] = useState(null);

  useEffect(() => {
    setCart(shopify.cart.current?.value);
    const unsub = shopify.cart.current?.subscribe?.((c) => setCart(c));
    return () => unsub?.();
  }, []);

  useEffect(() => {
    const customerId = cart?.customer?.id;
    if (!customerId) {
      setState({ kind: 'no_customer' });
      return;
    }
    setState({ kind: 'loading' });
    Promise.all([fetchBalance(customerId), fetchRewards()])
      .then(([bal, rewards]) => setState({ kind: 'loaded', bal, rewards }))
      .catch((err) => {
        console.error('[loyalty-pos] load failed', err);
        setState({ kind: 'error' });
      });
  }, [cart?.customer?.id]);

  return (
    <s-page heading={i18n.translate('modal_heading')}>
      <s-scroll-box>
        <s-box padding="medium">
          {renderBody({ i18n, cart, state, busyReward, setBusyReward, setState })}
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

function renderBody({ i18n, cart, state, busyReward, setBusyReward, setState }) {
  if (state.kind === 'no_customer') {
    return <s-text>{i18n.translate('modal_no_customer')}</s-text>;
  }
  if (state.kind === 'loading' || state.kind === 'idle') {
    return <s-text>{i18n.translate('modal_loading')}</s-text>;
  }
  if (state.kind === 'error') {
    return <s-text>{i18n.translate('modal_error')}</s-text>;
  }

  const { bal, rewards } = state;
  const customerName = [cart?.customer?.firstName, cart?.customer?.lastName]
    .filter(Boolean)
    .join(' ') || 'Customer';

  // POS only supports fixed_amount + percentage (no shipping / no product picker)
  const posCompatibleRewards = rewards.filter(
    (r) => r.rewardType === 'fixed_amount' || r.rewardType === 'percentage',
  );

  return (
    <s-stack direction="block" gap="medium">
      <s-text variant="strong">
        {i18n.translate('modal_balance_header', { name: customerName })}
      </s-text>

      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small">
          <s-text>{i18n.translate('modal_points_label')}:</s-text>
          <s-text variant="strong">{bal.points.toLocaleString('en-US')}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small">
          <s-text>{i18n.translate('modal_lifetime_label')}:</s-text>
          <s-text>{bal.lifetime_earned.toLocaleString('en-US')}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small">
          <s-text>{i18n.translate('modal_tier_label')}:</s-text>
          <s-text>{bal.vip_tier}</s-text>
        </s-stack>
      </s-stack>

      <s-divider />

      <s-text variant="strong">{i18n.translate('modal_redeem_title')}</s-text>

      <s-stack direction="block" gap="small">
        {posCompatibleRewards.length === 0 ? (
          <s-text>No POS-compatible rewards available.</s-text>
        ) : (
          posCompatibleRewards.map((reward) => {
            const affordable = bal.points >= reward.pointCost;
            const isBusy = busyReward === reward.id;
            return (
              <s-button
                key={reward.id}
                variant="primary"
                disabled={!affordable || busyReward !== null}
                loading={isBusy}
                onClick={() => applyRedemption({ reward, i18n, setBusyReward, setState, bal, rewards })}
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

async function applyRedemption({ reward, i18n, setBusyReward, setState, bal, rewards }) {
  setBusyReward(reward.id);
  try {
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
    } else {
      shopify.toast.show('Reward type not supported at POS — use the storefront.', { type: 'error' });
      return;
    }

    // Tag the cart so the orders/paid webhook decrements points + records the
    // reward type for the loyalty_transaction audit log.
    await shopify.cart.addCartProperties({
      loyalty_reward_id: reward.id,
      loyalty_reward_type: reward.rewardType,
      loyalty_reward_value: String(reward.value),
      loyalty_redeem_points: String(reward.pointCost),
    });

    shopify.toast.show(`${reward.name} applied`);
    setState({
      kind: 'loaded',
      bal: { ...bal, points: bal.points - reward.pointCost },
      rewards,
    });
    shopify.action.dismissModal();
  } catch (err) {
    console.error('[loyalty-pos] redemption failed', err);
    shopify.toast.show(i18n.translate('modal_redeem_failed'), { type: 'error' });
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
