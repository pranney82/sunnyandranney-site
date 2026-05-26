import type { Env } from '../env';
import { getCustomerLoyaltyState } from '../lib/shopify';

export async function handleBalance(env: Env, customerId: string): Promise<Response> {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
  try {
    const state = await getCustomerLoyaltyState(env, customerId);
    return new Response(
      JSON.stringify({
        points: state.points,
        lifetime_earned: state.lifetimeEarned,
        vip_tier: state.vipTier,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'unknown' }),
      { status: 500, headers: corsHeaders },
    );
  }
}
