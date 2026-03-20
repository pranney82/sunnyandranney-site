/**
 * Cloudflare Worker — syncs Google Places hours → D1 on a cron schedule.
 * Keeps the chatbot's hours data fresh without depending on deploys.
 */

interface Env {
  DB: D1Database;
  GOOGLE_PLACES_API_KEY: string;
  GOOGLE_PLACE_ID: string;
  CF_DEPLOY_HOOK_URL?: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function padTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface GoogleDate { year: number; month: number; day: number }

interface GoogleOpeningHours {
  periods?: Array<{
    open: { date?: GoogleDate; day: number; hour: number; minute: number };
    close?: { date?: GoogleDate; day: number; hour: number; minute: number };
  }>;
  specialDays?: Array<{ date?: GoogleDate }>;
}

async function syncHours(db: D1Database, apiKey: string, placeId: string): Promise<boolean> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'regularOpeningHours,currentOpeningHours',
    },
  });

  if (!res.ok) {
    console.warn(`[hours-sync] Google Places API returned ${res.status}`);
    return false;
  }

  const data = await res.json() as {
    regularOpeningHours?: GoogleOpeningHours;
    currentOpeningHours?: GoogleOpeningHours;
  };

  const regular = data.regularOpeningHours;
  const current = data.currentOpeningHours;

  if (!regular?.periods?.length) {
    console.warn('[hours-sync] No opening hours data returned');
    return false;
  }

  const dayMap = new Map<number, { open: string; close: string }>();
  for (const period of regular.periods) {
    dayMap.set(period.open.day, {
      open: padTime(period.open.hour, period.open.minute),
      close: period.close ? padTime(period.close.hour, period.close.minute) : '23:59',
    });
  }

  const days = [1, 2, 3, 4, 5, 6, 0].map(dayNum => {
    const times = dayMap.get(dayNum);
    return {
      day: DAY_NAMES[dayNum],
      open: times?.open ?? '00:00',
      close: times?.close ?? '00:00',
      closed: !times,
    };
  });

  const holidays: Array<{ date: string; label: string; closed: boolean; open: string; close: string }> = [];
  if (current?.specialDays) {
    for (const special of current.specialDays) {
      if (!special.date) continue;
      const dateStr = `${special.date.year}-${String(special.date.month).padStart(2, '0')}-${String(special.date.day).padStart(2, '0')}`;
      const d = new Date(dateStr + 'T12:00:00');
      const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

      const matchingPeriod = current.periods?.find(p =>
        p.open.date &&
        p.open.date.year === special.date!.year &&
        p.open.date.month === special.date!.month &&
        p.open.date.day === special.date!.day
      );

      if (matchingPeriod) {
        holidays.push({
          date: dateStr, label, closed: false,
          open: padTime(matchingPeriod.open.hour, matchingPeriod.open.minute),
          close: matchingPeriod.close ? padTime(matchingPeriod.close.hour, matchingPeriod.close.minute) : '23:59',
        });
      } else {
        holidays.push({ date: dateStr, label, closed: true, open: '00:00', close: '00:00' });
      }
    }
  }

  await db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('settings:hours', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(JSON.stringify({ days, holidays, note: '' })).run();

  console.log('[hours-sync] Google hours synced to D1');
  return true;
}

/** If products were synced but no deploy followed, trigger one now. */
async function deployIfPending(db: D1Database, hookUrl: string): Promise<void> {
  try {
    const [syncRow, rebuildRow] = await Promise.all([
      db.prepare("SELECT value FROM settings WHERE key = 'last_sync'").first<{ value: string }>(),
      db.prepare("SELECT value FROM settings WHERE key = 'last_rebuild'").first<{ value: string }>(),
    ]);

    const lastSync = syncRow ? Number(syncRow.value) : 0;
    const lastRebuild = rebuildRow ? Number(rebuildRow.value) : 0;

    if (lastSync > lastRebuild) {
      const res = await fetch(hookUrl, { method: 'POST' });
      if (res.ok) {
        await db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES ('last_rebuild', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).bind(String(Date.now())).run();
        console.log('[hours-sync] Triggered pending deploy');
      }
    }
  } catch (err) {
    console.error('[hours-sync] Deploy check failed:', err);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.GOOGLE_PLACES_API_KEY || !env.GOOGLE_PLACE_ID) {
      console.error('[hours-sync] Missing GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID');
      return;
    }
    ctx.waitUntil(syncHours(env.DB, env.GOOGLE_PLACES_API_KEY, env.GOOGLE_PLACE_ID));

    if (env.CF_DEPLOY_HOOK_URL) {
      ctx.waitUntil(deployIfPending(env.DB, env.CF_DEPLOY_HOOK_URL));
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.GOOGLE_PLACES_API_KEY || !env.GOOGLE_PLACE_ID) {
      return new Response('Missing secrets', { status: 500 });
    }
    const ok = await syncHours(env.DB, env.GOOGLE_PLACES_API_KEY, env.GOOGLE_PLACE_ID);
    return new Response(ok ? 'Synced' : 'Failed', { status: ok ? 200 : 500 });
  },
} satisfies ExportedHandler<Env>;
