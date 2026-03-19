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
