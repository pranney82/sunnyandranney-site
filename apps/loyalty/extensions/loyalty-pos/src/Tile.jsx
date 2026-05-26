import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const LOYALTY_BASE = 'https://loyalty.soard.workers.dev';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const [state, setState] = useState({ kind: 'idle' });

  useEffect(() => {
    const handleCart = (cart) => {
      const customerId = cart?.customer?.id;
      if (!customerId) {
        setState({ kind: 'no_customer' });
        return;
      }
      setState({ kind: 'loading' });
      fetchBalance(customerId)
        .then((bal) => setState({ kind: 'loaded', bal }))
        .catch(() => setState({ kind: 'error' }));
    };
    handleCart(shopify.cart.current?.value);
    const unsub = shopify.cart.current?.subscribe?.(handleCart);
    return () => unsub?.();
  }, []);

  const subheading = (() => {
    switch (state.kind) {
      case 'no_customer': return i18n.translate('tile_subheading_no_customer');
      case 'loading': return i18n.translate('tile_subheading_loading');
      case 'error': return i18n.translate('tile_subheading_error');
      case 'loaded':
        return i18n.translate('tile_subheading_balance', {
          points: state.bal.points.toLocaleString('en-US'),
          tier: state.bal.vip_tier,
        });
      default: return '';
    }
  })();

  return (
    <s-tile
      heading={i18n.translate('tile_heading')}
      subheading={subheading}
      onClick={() => shopify.action.presentModal()}
    />
  );
}

async function fetchBalance(customerId) {
  const gid = normalizeCustomerGid(customerId);
  const url = `${LOYALTY_BASE}/api/customer/balance?customer_id=${encodeURIComponent(gid)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`balance ${res.status}`);
  return res.json();
}

function normalizeCustomerGid(id) {
  if (typeof id === 'string' && id.startsWith('gid://shopify/Customer/')) return id;
  return `gid://shopify/Customer/${id}`;
}
