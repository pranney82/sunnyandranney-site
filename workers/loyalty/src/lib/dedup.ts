export async function alreadyProcessed(
  db: D1Database,
  webhookId: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT webhook_id FROM loyalty_webhook_log WHERE webhook_id = ?')
    .bind(webhookId)
    .first();
  return row !== null;
}

export async function recordProcessed(
  db: D1Database,
  webhookId: string,
  topic: string,
  shopDomain: string,
  status: 'processed' | 'failed' = 'processed',
  errorMessage?: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO loyalty_webhook_log (webhook_id, topic, shop_domain, status, error_message) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(webhookId, topic, shopDomain, status, errorMessage ?? null)
    .run();
}
