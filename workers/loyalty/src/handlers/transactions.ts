import type { Env } from '../env';
import { adminGraphQL } from '../lib/shopify';

interface MetaobjectField {
  key: string;
  value: string;
}

interface MetaobjectNode {
  id: string;
  fields: MetaobjectField[];
}

export async function handleListTransactions(
  env: Env,
  customerId: string,
  limit: number,
): Promise<Response> {
  // Metaobjects API doesn't support reliable server-side filtering by reference fields,
  // so we fetch a larger page and filter client-side. Volumes per customer stay small.
  const fetchSize = Math.min(250, Math.max(50, limit * 10));

  const data = await adminGraphQL<{
    metaobjects: { nodes: MetaobjectNode[] };
  }>(
    env,
    `query($first: Int!) {
      metaobjects(type: "$app:loyalty_transaction", first: $first, sortKey: "updated_at", reverse: true) {
        nodes { id fields { key value } }
      }
    }`,
    { first: fetchSize },
  );

  const transactions = data.metaobjects.nodes
    .map(parseTransaction)
    .filter((tx) => tx.customer_id === customerId)
    .slice(0, limit);

  return new Response(JSON.stringify({ transactions }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function parseTransaction(node: MetaobjectNode): {
  id: string;
  customer_id: string;
  type: string;
  amount: number;
  balance_after: number;
  timestamp: string;
  order_id: string | null;
  notes: string | null;
} {
  const f: Record<string, string> = {};
  for (const field of node.fields) f[field.key] = field.value;
  return {
    id: node.id,
    customer_id: f.customer ?? '',
    type: f.type ?? 'unknown',
    amount: parseInt(f.amount ?? '0', 10),
    balance_after: parseInt(f.balance_after ?? '0', 10),
    timestamp: f.timestamp ?? '',
    order_id: f.order ?? null,
    notes: f.notes ?? null,
  };
}
