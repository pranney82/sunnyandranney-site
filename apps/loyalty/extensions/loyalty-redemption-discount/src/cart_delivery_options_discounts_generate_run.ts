import {
  DiscountClass,
  DeliveryDiscountSelectionStrategy,
  CartDeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from '../generated/api';

const EMPTY: CartDeliveryOptionsDiscountsGenerateRunResult = { operations: [] };

export function cartDeliveryOptionsDiscountsGenerateRun(
  input: CartDeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  const rewardType = input.cart.rewardType?.value;
  if (rewardType !== 'free_shipping') return EMPTY;
  if (!input.discount.discountClasses.includes(DiscountClass.Shipping)) return EMPTY;

  // Apply 100% off to every available delivery option in every group.
  const targets = input.cart.deliveryGroups.flatMap((group) =>
    group.deliveryOptions.map((opt) => ({ deliveryOption: { handle: opt.handle } })),
  );
  if (targets.length === 0) return EMPTY;

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: [
            {
              message: 'Loyalty: Free shipping',
              targets,
              value: { percentage: { value: '100.0' } },
            },
          ],
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
