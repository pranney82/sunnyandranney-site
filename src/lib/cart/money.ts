import type { Money } from './types';

// Currency-aware money formatting. Reads currencyCode from the Money value
// so multi-currency works without ceremony. Caches formatters per currency.

const _formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let f = _formatters.get(currency);
  if (f) return f;
  try {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    });
  } catch {
    // Unknown currency — fall back to a generic formatter that prefixes the code.
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 });
  }
  _formatters.set(currency, f);
  return f;
}

export function formatMoney(money: Money | null | undefined): string {
  if (!money) return '';
  const amount = parseFloat(money.amount);
  if (!Number.isFinite(amount)) return '';
  return formatterFor(money.currencyCode).format(amount);
}

export function moneyAmount(money: Money | null | undefined): number {
  if (!money) return 0;
  const n = parseFloat(money.amount);
  return Number.isFinite(n) ? n : 0;
}

export function multiplyMoney(money: Money, factor: number): Money {
  return { amount: (moneyAmount(money) * factor).toFixed(2), currencyCode: money.currencyCode };
}

export function zeroMoney(currencyCode = 'USD'): Money {
  return { amount: '0.00', currencyCode };
}
