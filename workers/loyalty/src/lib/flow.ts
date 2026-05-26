import type { Env } from '../env';
import { adminGraphQL } from './shopify';

// Custom Flow triggers defined in apps/loyalty/extensions/loyalty-flow-triggers/.
// Merchants build Flow workflows that subscribe to these handles and send
// Shopify Email notifications in response.
export type FlowTriggerHandle =
  | 'loyalty-points-earned'
  | 'loyalty-tier-upgraded'
  | 'loyalty-points-redeemed';

const TRIGGER_MUTATION = `
  mutation FlowTriggerReceive($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors { field message }
    }
  }
`;

// Fire-and-forget. Trigger failures are non-fatal — emails are noisy but the
// loyalty math + audit log are the source of truth.
export async function fireFlowTrigger(
  env: Env,
  handle: FlowTriggerHandle,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const data = await adminGraphQL<{
      flowTriggerReceive: { userErrors: Array<{ field: string[]; message: string }> };
    }>(env, TRIGGER_MUTATION, { handle, payload });

    if (data.flowTriggerReceive.userErrors.length > 0) {
      console.warn(
        `[flow] ${handle} userErrors: ${data.flowTriggerReceive.userErrors
          .map((e) => `${e.field.join('.')}: ${e.message}`)
          .join('; ')}`,
      );
    }
  } catch (err) {
    console.warn(`[flow] ${handle} failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}
