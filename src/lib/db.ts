/**
 * D1 database helpers for settings reads and rate limiting.
 *
 * Architecture:
 *  - D1 is the fast read layer (sub-ms edge reads)
 *  - Settings are committed JSON files in src/content/settings/ (source of truth)
 *  - D1 settings are seeded from those files and used by runtime API routes (chat)
 */
import { env } from 'cloudflare:workers';

// ─── Settings (read-only) ────────────────────────────────────

/** Read a setting from D1 (fast, edge-local) */
export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row ? JSON.parse(row.value) as T : null;
  } catch (err) {
    console.error(`D1 read error (${key}):`, err);
    return null;
  }
}

/** Read all settings from D1 */
export async function getAllSettings(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  try {
    const rows = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
    for (const row of rows.results) {
      results[row.key] = JSON.parse(row.value);
    }
  } catch (err) {
    console.error('D1 read all error:', err);
  }
  return results;
}

// ─── Chat Sessions (cross-session memory) ──────────────────────────

interface ChatSession {
  messages: Array<{ role: string; content: string }>;
  summary: string;
}

/** Load a chat session from D1 */
export async function getSession(sessionId: string): Promise<ChatSession | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT messages, summary FROM chat_sessions WHERE session_id = ?'
    ).bind(sessionId).first<{ messages: string; summary: string }>();
    if (!row) return null;
    return {
      messages: JSON.parse(row.messages),
      summary: row.summary || '',
    };
  } catch (err) {
    console.error('Session read error:', err);
    return null;
  }
}

/** Create or update a chat session in D1 */
export async function upsertSession(
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
  summary?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO chat_sessions (session_id, messages, summary, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         messages = excluded.messages,
         summary = COALESCE(excluded.summary, chat_sessions.summary),
         updated_at = excluded.updated_at`
    ).bind(sessionId, JSON.stringify(messages), summary ?? '').run();
  } catch (err) {
    console.error('Session upsert error:', err);
  }
}

/** Probabilistic cleanup of expired sessions (call on ~1% of requests) */
export async function cleanExpiredSessions(ttlDays = 30): Promise<void> {
  try {
    await env.DB.prepare(
      `DELETE FROM chat_sessions WHERE updated_at < datetime('now', ?)`
    ).bind(`-${ttlDays} days`).run();
  } catch (err) {
    console.error('Session cleanup error:', err);
  }
}

// ─── Product Availability (real-time, webhook-updated) ──────────────

/** Get availability for multiple products in a single query */
export async function getProductAvailability(handles: string[]): Promise<Map<string, boolean>> {
  const availability = new Map<string, boolean>();
  if (!handles.length) return availability;

  try {
    // Batch query with placeholders
    const placeholders = handles.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT handle, available FROM product_availability WHERE handle IN (${placeholders})`
    ).bind(...handles).all<{ handle: string; available: number }>();

    for (const row of rows.results) {
      availability.set(row.handle, row.available === 1);
    }
  } catch (err) {
    console.error('Availability read error:', err);
  }

  return availability;
}

/** Update availability for a single product (atomic, no race conditions) */
export async function setProductAvailability(handle: string, available: boolean): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO product_availability (handle, available, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(handle) DO UPDATE SET
         available = excluded.available,
         updated_at = excluded.updated_at`
    ).bind(handle, available ? 1 : 0).run();
  } catch (err) {
    console.error('Availability update error:', err);
  }
}

/** Batch update availability (for full sync) */
export async function batchSetProductAvailability(
  products: Array<{ handle: string; available: boolean }>
): Promise<void> {
  if (!products.length) return;

  try {
    // D1 batch API for atomic multi-row operations
    const statements = products.map(p =>
      env.DB.prepare(
        `INSERT INTO product_availability (handle, available, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(handle) DO UPDATE SET
           available = excluded.available,
           updated_at = excluded.updated_at`
      ).bind(p.handle, p.available ? 1 : 0)
    );

    await env.DB.batch(statements);
  } catch (err) {
    console.error('Batch availability update error:', err);
  }
}

/** Remove stale products no longer in catalog */
export async function pruneStaleAvailability(validHandles: Set<string>): Promise<void> {
  if (!validHandles.size) return;

  try {
    const placeholders = Array.from(validHandles).map(() => '?').join(',');
    await env.DB.prepare(
      `DELETE FROM product_availability WHERE handle NOT IN (${placeholders})`
    ).bind(...validHandles).run();
  } catch (err) {
    console.error('Availability prune error:', err);
  }
}

// ─── Inventory Item Mapping (for webhook lookups) ───────────────────

/** Get product handle from inventory_item_id */
export async function getHandleByInventoryItemId(inventoryItemId: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT handle FROM inventory_item_map WHERE inventory_item_id = ?'
    ).bind(inventoryItemId).first<{ handle: string }>();
    return row?.handle || null;
  } catch (err) {
    console.error('Inventory map lookup error:', err);
    return null;
  }
}

/** Batch populate inventory_item_id → handle mapping (for full sync) */
export async function batchSetInventoryItemMap(
  items: Array<{ inventoryItemId: string; handle: string }>
): Promise<void> {
  if (!items.length) return;

  try {
    const statements = items.map(item =>
      env.DB.prepare(
        `INSERT INTO inventory_item_map (inventory_item_id, handle)
         VALUES (?, ?)
         ON CONFLICT(inventory_item_id) DO UPDATE SET handle = excluded.handle`
      ).bind(item.inventoryItemId, item.handle)
    );

    await env.DB.batch(statements);
  } catch (err) {
    console.error('Batch inventory map error:', err);
  }
}

/** Remove stale mappings for products no longer in catalog */
export async function pruneStaleInventoryMap(validHandles: Set<string>): Promise<void> {
  if (!validHandles.size) return;

  try {
    const placeholders = Array.from(validHandles).map(() => '?').join(',');
    await env.DB.prepare(
      `DELETE FROM inventory_item_map WHERE handle NOT IN (${placeholders})`
    ).bind(...validHandles).run();
  } catch (err) {
    console.error('Inventory map prune error:', err);
  }
}

// ─── Rate Limiting (D1-backed, atomic, persistent across instances) ──

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = Date.now();
  const expiresAt = now + windowSeconds * 1000;

  try {
    // Clean expired entries occasionally (1 in 20 chance)
    if (Math.random() < 0.05) {
      await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
    }

    // Atomic upsert: reset window if expired, otherwise increment
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN expires_at < ? THEN 1 ELSE count + 1 END,
         expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END
       RETURNING count`
    ).bind(key, expiresAt, now, now, expiresAt).first<{ count: number }>();

    if (!row) return true; // Shouldn't happen, but fail open
    return row.count <= maxRequests;
  } catch (err) {
    console.error('Rate limit error:', err);
    return true; // Fail open
  }
}
