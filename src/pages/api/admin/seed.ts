import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const GITHUB_API = 'https://api.github.com';

const SETTINGS_FILES: Record<string, string> = {
  'settings:hours': 'src/content/settings/hours.json',
  'settings:collections': 'src/content/settings/collections.json',
  'settings:specials': 'src/content/settings/specials.json',
};

/**
 * POST /api/admin/seed
 * Reads all settings from GitHub and writes them to D1.
 * Use this to bootstrap D1 on first deploy or re-sync if D1 gets wiped.
 */
export const POST: APIRoute = async () => {
  const results: Record<string, string> = {};

  for (const [key, path] of Object.entries(SETTINGS_FILES)) {
    try {
      // Read from GitHub
      const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${path}`, {
        headers: {
          Authorization: `token ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'sunnyandranney-admin',
        },
      });

      if (res.status === 404) {
        results[key] = 'not found in GitHub (skipped)';
        continue;
      }

      if (!res.ok) {
        results[key] = `GitHub error: ${res.status}`;
        continue;
      }

      const data = await res.json() as { content: string };
      const decoded = atob(data.content.replace(/\n/g, ''));

      // Validate it's valid JSON
      JSON.parse(decoded);

      // Write to D1
      await env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(key, decoded).run();

      results[key] = 'synced';
    } catch (err: any) {
      results[key] = `error: ${err?.message}`;
    }
  }

  return new Response(JSON.stringify({ results }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
