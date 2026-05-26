import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const LOYALTY_BASE = 'https://loyalty.soard.workers.dev';

export default async () => {
  render(<Extension />, document.body);
};

const LOAD_QUERY = `
  query LoadLoyalty($id: ID!) {
    customer(id: $id) {
      id
      points: metafield(namespace: "$app:loyalty", key: "points") { value }
      lifetimeEarned: metafield(namespace: "$app:loyalty", key: "lifetime_earned") { value }
      vipTier: metafield(namespace: "$app:loyalty", key: "vip_tier") { value }
    }
  }
`;

function Extension() {
  const { i18n, data } = shopify;
  const customerId = data.selected[0]?.id;
  const [state, setState] = useState({ kind: 'loading' });

  useEffect(() => {
    if (!customerId) {
      setState({ kind: 'error' });
      return;
    }
    (async () => {
      try {
        const res = await fetch('shopify:admin/api/graphql.json', {
          method: 'POST',
          body: JSON.stringify({ query: LOAD_QUERY, variables: { id: customerId } }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
        const c = json.data?.customer;
        if (!c) throw new Error('customer not found');

        const points = c.points ? parseInt(c.points.value, 10) : 0;
        const lifetime = c.lifetimeEarned ? parseInt(c.lifetimeEarned.value, 10) : 0;
        const tier = c.vipTier?.value ?? 'Bronze';

        // Recent transactions (best-effort; non-fatal if worker is down)
        let transactions = [];
        try {
          const txRes = await fetch(
            `${LOYALTY_BASE}/api/customer/transactions?customer_id=${encodeURIComponent(customerId)}&limit=5`,
          );
          if (txRes.ok) {
            const txJson = await txRes.json();
            transactions = txJson.transactions ?? [];
          }
        } catch (err) {
          console.warn('[loyalty-customer-block] transactions fetch failed', err);
        }

        setState({ kind: 'loaded', points, lifetime, tier, transactions });
      } catch (err) {
        console.error('[loyalty-customer-block] load failed', err);
        setState({ kind: 'error' });
      }
    })();
  }, [customerId]);

  return (
    <s-admin-block title={i18n.translate('block_heading')}>
      {renderBody({ i18n, state })}
    </s-admin-block>
  );
}

function renderBody({ i18n, state }) {
  if (state.kind === 'loading') {
    return <s-text>{i18n.translate('loading')}</s-text>;
  }
  if (state.kind === 'error') {
    return <s-banner tone="critical">{i18n.translate('error')}</s-banner>;
  }

  const { points, lifetime, tier, transactions } = state;
  const tierTone = tier === 'Gold' ? 'success' : tier === 'Silver' ? 'info' : 'default';

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="large" alignment="center">
        <s-stack direction="block" gap="extra-tight">
          <s-text variant="bodySm" color="subdued">{i18n.translate('points_label')}</s-text>
          <s-heading>{points.toLocaleString('en-US')}</s-heading>
        </s-stack>
        <s-stack direction="block" gap="extra-tight">
          <s-text variant="bodySm" color="subdued">{i18n.translate('lifetime_label')}</s-text>
          <s-heading>{lifetime.toLocaleString('en-US')}</s-heading>
        </s-stack>
        <s-stack direction="block" gap="extra-tight">
          <s-text variant="bodySm" color="subdued">{i18n.translate('tier_label')}</s-text>
          <s-badge tone={tierTone}>{tier}</s-badge>
        </s-stack>
      </s-stack>

      <s-divider />

      <s-text variant="bodyLg">{i18n.translate('recent_transactions')}</s-text>
      {transactions.length === 0 ? (
        <s-text color="subdued">{i18n.translate('no_transactions')}</s-text>
      ) : (
        <s-stack direction="block" gap="tight">
          {transactions.map((tx) => (
            <s-stack key={tx.id} direction="inline" gap="base" alignment="space-between">
              <s-text>{labelFor(tx.type, i18n)}</s-text>
              <s-text variant="strong">
                {(tx.amount > 0 ? '+' : '') + tx.amount.toLocaleString('en-US')} pts
              </s-text>
              <s-text color="subdued">{formatDate(tx.timestamp)}</s-text>
            </s-stack>
          ))}
        </s-stack>
      )}
    </s-stack>
  );
}

function labelFor(type, i18n) {
  switch (type) {
    case 'earn': return i18n.translate('tx_earn');
    case 'redeem': return i18n.translate('tx_redeem');
    case 'adjust': return i18n.translate('tx_adjust');
    case 'refund_clawback': return i18n.translate('tx_refund_clawback');
    default: return type;
  }
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
