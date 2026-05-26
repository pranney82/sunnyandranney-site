import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
};

const LOAD_QUERY = `
  query LoadLoyalty($id: ID!) {
    customer(id: $id) {
      id
      displayName
      points: metafield(namespace: "$app:loyalty", key: "points") {
        value
        compareDigest
      }
      lifetimeEarned: metafield(namespace: "$app:loyalty", key: "lifetime_earned") {
        value
        compareDigest
      }
      vipTier: metafield(namespace: "$app:loyalty", key: "vip_tier") {
        value
      }
    }
  }
`;

const SET_METAFIELDS = `
  mutation Set($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key value }
      userErrors { field message }
    }
  }
`;

const CREATE_TRANSACTION = `
  mutation Tx($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message }
    }
  }
`;

function Extension() {
  const { i18n, close, data } = shopify;
  const customerId = data.selected[0]?.id;

  const [loadState, setLoadState] = useState({ kind: 'loading' });
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [submitState, setSubmitState] = useState({ kind: 'idle' });

  useEffect(() => {
    if (!customerId) return;
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
        setLoadState({
          kind: 'loaded',
          customer: {
            id: c.id,
            displayName: c.displayName,
            points: c.points ? parseInt(c.points.value, 10) : 0,
            pointsDigest: c.points?.compareDigest ?? null,
            lifetimeEarned: c.lifetimeEarned ? parseInt(c.lifetimeEarned.value, 10) : 0,
            vipTier: c.vipTier?.value ?? 'Bronze',
          },
        });
      } catch (err) {
        console.error('[loyalty-adjust] load failed', err);
        setLoadState({ kind: 'error' });
      }
    })();
  }, [customerId]);

  const onSubmit = async () => {
    if (loadState.kind !== 'loaded') return;
    const deltaNum = parseInt(delta, 10);
    if (!Number.isFinite(deltaNum) || deltaNum === 0) {
      setSubmitState({ kind: 'error', message: i18n.translate('error_zero') });
      return;
    }
    setSubmitState({ kind: 'submitting' });

    const current = loadState.customer;
    const newBalance = Math.max(0, current.points + deltaNum);

    try {
      const setRes = await fetch('shopify:admin/api/graphql.json', {
        method: 'POST',
        body: JSON.stringify({
          query: SET_METAFIELDS,
          variables: {
            metafields: [
              {
                ownerId: current.id,
                namespace: '$app:loyalty',
                key: 'points',
                type: 'number_integer',
                value: String(newBalance),
                ...(current.pointsDigest ? { compareDigest: current.pointsDigest } : {}),
              },
            ],
          },
        }),
      });
      const setJson = await setRes.json();
      if (setJson.errors) {
        throw new Error(setJson.errors.map((e) => e.message).join('; '));
      }
      const setErrs = setJson.data?.metafieldsSet?.userErrors ?? [];
      if (setErrs.length > 0) {
        throw new Error(setErrs.map((e) => e.message).join('; '));
      }

      // Audit log — fire-and-forget; metafield write is the source of truth.
      try {
        await fetch('shopify:admin/api/graphql.json', {
          method: 'POST',
          body: JSON.stringify({
            query: CREATE_TRANSACTION,
            variables: {
              metaobject: {
                type: '$app:loyalty_transaction',
                fields: [
                  { key: 'customer', value: current.id },
                  { key: 'type', value: 'adjust' },
                  { key: 'amount', value: String(deltaNum) },
                  { key: 'balance_after', value: String(newBalance) },
                  { key: 'timestamp', value: new Date().toISOString() },
                  ...(reason ? [{ key: 'notes', value: reason }] : []),
                ],
              },
            },
          }),
        });
      } catch (err) {
        console.warn('[loyalty-adjust] transaction log failed (non-fatal)', err);
      }

      if (shopify.toast?.show) {
        shopify.toast.show(
          i18n.translate('success', { balance: newBalance.toLocaleString('en-US') }),
        );
      }
      close();
    } catch (err) {
      console.error('[loyalty-adjust] apply failed', err);
      setSubmitState({
        kind: 'error',
        message: err instanceof Error ? err.message : i18n.translate('error_apply'),
      });
    }
  };

  return (
    <s-admin-action heading={i18n.translate('title')}>
      {renderBody({ loadState, delta, setDelta, reason, setReason, submitState, i18n })}

      <s-button
        slot="primary-action"
        variant="primary"
        disabled={loadState.kind !== 'loaded' || submitState.kind === 'submitting'}
        loading={submitState.kind === 'submitting'}
        onClick={onSubmit}
      >
        {submitState.kind === 'submitting'
          ? i18n.translate('submitting')
          : i18n.translate('submit')}
      </s-button>
      <s-button slot="secondary-actions" onClick={() => close()}>Cancel</s-button>
    </s-admin-action>
  );
}

function renderBody({ loadState, delta, setDelta, reason, setReason, submitState, i18n }) {
  if (loadState.kind === 'loading') {
    return <s-text>{i18n.translate('loading')}</s-text>;
  }
  if (loadState.kind === 'error') {
    return <s-text>{i18n.translate('error_load')}</s-text>;
  }
  const c = loadState.customer;

  return (
    <s-stack direction="block" gap="medium">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small">
          <s-text>{i18n.translate('current_balance')}:</s-text>
          <s-text variant="strong">{c.points.toLocaleString('en-US')} pts</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small">
          <s-text>{i18n.translate('current_tier')}:</s-text>
          <s-text>{c.vipTier}</s-text>
        </s-stack>
      </s-stack>

      <s-divider />

      <s-number-field
        label={i18n.translate('delta_label')}
        helpText={i18n.translate('delta_help')}
        value={delta}
        onChange={(e) => setDelta(e.target.value)}
      />
      <s-text-area
        label={i18n.translate('reason_label')}
        placeholder={i18n.translate('reason_placeholder')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
      />

      {submitState.kind === 'error' && (
        <s-banner tone="critical">{submitState.message}</s-banner>
      )}
    </s-stack>
  );
}
