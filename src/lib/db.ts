/**
 * D1 database helpers for settings and rate limiting.
 *
 * Architecture:
 *  - D1 is the fast read layer (sub-ms edge reads)
 *  - GitHub Contents API is the source of truth (each admin save = git commit)
 *  - Admin writes go to BOTH D1 and GitHub simultaneously
 */
import { env } from 'cloudflare:workers';

const GITHUB_API = 'https://api.github.com';

// Maps setting keys → file paths in the repo
const SETTINGS_PATHS: Record<string, string> = {
  'settings:hours': 'src/content/settings/hours.json',
  'settings:collections': 'src/content/settings/collections.json',
  'settings:specials': 'src/content/settings/specials.json',
  'settings:contact': 'src/content/settings/contact.json',
  'settings:email-signup': 'src/content/settings/email-signup.json',
  'settings:trending': 'src/content/settings/trending.json',
  'settings:hero': 'src/content/settings/hero.json',
  'settings:kids': 'src/content/settings/kids.json',
};

// ─── Settings ────────────────────────────────────────────────

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

/**
 * Save a setting to D1 AND commit to GitHub (dual write).
 * D1 is updated first for immediate consistency, then GitHub for persistence.
 */
export async function saveSetting(
  key: string,
  value: unknown,
): Promise<{ success: boolean; error?: string; warning?: string }> {
  const json = JSON.stringify(value);

  // 1. Write to D1 (fast, immediate)
  try {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, json).run();
  } catch (err: any) {
    console.error(`D1 write error (${key}):`, err);
    return { success: false, error: 'Database write failed' };
  }

  // 2. Write to GitHub (source of truth, triggers rebuild)
  const path = SETTINGS_PATHS[key];
  if (path) {
    try {
      await commitToGitHub(path, value, `Update ${key.replace('settings:', '')} settings`);
    } catch (err) {
      console.error(`GitHub commit failed for ${key}:`, err);
      return { success: true, warning: `Saved to database but failed to publish: ${err instanceof Error ? err.message : 'Unknown error'}` };
    }
  }

  return { success: true };
}

// ─── Helpers ─────────────────────────────────────────────────

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ─── GitHub write-through ────────────────────────────────────

function githubHeaders() {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'sunnyandranney-admin',
    'Content-Type': 'application/json',
  };
}

async function commitToGitHub(path: string, content: unknown, message: string) {
  const repo = env.GITHUB_REPO;

  // Get current file SHA (needed for updates)
  let sha: string | undefined;
  const existing = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    headers: githubHeaders(),
  });
  if (existing.ok) {
    const data = await existing.json() as { sha: string };
    sha = data.sha;
  }

  const body: Record<string, string> = {
    message,
    content: toBase64(JSON.stringify(content, null, 2)),
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err}`);
  }
}

// ─── Rate Limiting (D1-backed, persistent across instances) ──

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = Date.now();

  try {
    // Clean expired entries occasionally (1 in 20 chance)
    if (Math.random() < 0.05) {
      await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
    }

    const row = await env.DB.prepare('SELECT count, expires_at FROM rate_limits WHERE key = ?')
      .bind(key)
      .first<{ count: number; expires_at: number }>();

    if (!row || now > row.expires_at) {
      // New window
      await env.DB.prepare(
        `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at`
      ).bind(key, now + windowSeconds * 1000).run();
      return true;
    }

    if (row.count >= maxRequests) return false;

    // Increment
    await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
      .bind(key).run();
    return true;
  } catch (err) {
    console.error('Rate limit error:', err);
    return true; // Fail open
  }
}
