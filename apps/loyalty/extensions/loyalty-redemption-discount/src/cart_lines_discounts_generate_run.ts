import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
} from '../generated/api';

const POINTS_PER_DOLLAR = 100;
const EMPTY: CartLinesDiscountsGenerateRunResult = { operations: [] };

// Reward types are written to the cart as `loyalty_reward_type` attribute
// by the storefront /api/loyalty/redeem endpoint or by the POS modal.
// Free-shipping rewards live on the delivery-options target, not this one.
type RewardType = 'fixed_amount' | 'percentage' | 'free_product';

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  const cart = input.cart;
  const rewardType = cart.rewardType?.value as RewardType | undefined;
  const rewardValueRaw = cart.rewardValue?.value;
  const rewardVariantId = cart.rewardVariantId?.value;
  const pointsRaw = cart.pointsAttr?.value;

  // Backwards-compat: pre-Phase-D carts that only set `loyalty_redeem_points`
  // are treated as a fixed_amount redemption at 100pts = $1.
  if (!rewardType && pointsRaw) {
    const points = parseInt(pointsRaw, 10);
    if (!Number.isFinite(points) || points <= 0) return EMPTY;
    if (!input.discount.discountClasses.includes(DiscountClass.Order)) return EMPTY;
    const subtotal = parseFloat(cart.cost.subtotalAmount.amount);
    const amount = Math.min(points / POINTS_PER_DOLLAR, subtotal).toFixed(2);
    return fixedAmountResult(amount, `Loyalty redemption: ${points} points`);
  }

  if (!rewardType || !rewardValueRaw) return EMPTY;
  const value = parseFloat(rewardValueRaw);
  if (!Number.isFinite(value) || value <= 0) return EMPTY;

  switch (rewardType) {
    case 'fixed_amount': {
      if (!input.discount.discountClasses.includes(DiscountClass.Order)) return EMPTY;
      const subtotal = parseFloat(cart.cost.subtotalAmount.amount);
      const amount = Math.min(value, subtotal).toFixed(2);
      return fixedAmountResult(amount, `Loyalty: $${value.toFixed(2)} off`);
    }
    case 'percentage': {
      if (!input.discount.discountClasses.includes(DiscountClass.Order)) return EMPTY;
      const pct = Math.min(value, 100);
      return percentageResult(pct);
    }
    case 'free_product': {
      if (!input.discount.discountClasses.includes(DiscountClass.Product)) return EMPTY;
      if (!rewardVariantId) return EMPTY;
      const match = cart.lines.find(
        (l) => l.merchandise.__typename === 'ProductVariant' && l.merchandise.id === rewardVariantId,
      );
      if (!match) return EMPTY;
      return freeProductResult(match.id);
    }
    default:
      return EMPTY;
  }
}

function fixedAmountResult(amount: string, message: string): CartLinesDiscountsGenerateRunResult {
  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message,
              targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              value: { fixedAmount: { amount } },
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}

function percentageResult(percent: number): CartLinesDiscountsGenerateRunResult {
  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: `Loyalty: ${percent}% off`,
              targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              value: { percentage: { value: percent.toFixed(1) } },
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}

function freeProductResult(lineId: string): CartLinesDiscountsGenerateRunResult {
  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: 'Loyalty: Free item',
              targets: [{ cartLine: { id: lineId, quantity: 1 } }],
              value: { percentage: { value: '100.0' } },
            },
          ],
          selectionStrategy: ProductDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
