interface TierConfig {
  name: string;
  threshold: number;
  multiplier: number;
}

// Mirrors the loyalty_tier metaobject seeds. Hardcoded for fast in-Worker lookup;
// staff can edit the metaobjects in admin for display purposes, but earn computation
// uses these values to avoid an extra GraphQL call per order.
const TIERS: TierConfig[] = [
  { name: 'Bronze', threshold: 0, multiplier: 1.0 },
  { name: 'Silver', threshold: 500, multiplier: 1.25 },
  { name: 'Gold', threshold: 2000, multiplier: 1.5 },
];

export function computeTier(lifetimeEarned: number): TierConfig {
  let current = TIERS[0];
  for (const t of TIERS) {
    if (lifetimeEarned >= t.threshold) current = t;
  }
  return current;
}
