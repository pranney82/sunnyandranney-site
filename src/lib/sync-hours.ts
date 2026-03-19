/**
 * Fetches live store hours from Google Places API and writes them to D1.
 * Shared by sync-products (automatic) and sync-settings (manual) endpoints.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function padTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface GoogleDate {
  year: number;
  month: number;
  day: number;
}

interface GoogleOpeningHours {
  periods?: Array<{
    open: { date?: GoogleDate; day: number; hour: number; minute: number };
    close?: { date?: GoogleDate; day: number; hour: number; minute: number };
  }>;
  specialDays?: Array<{
    date?: GoogleDate;
  }>;
}

/**
 * Fetch hours from Google Places API and upsert into D1.
 * Returns true if hours were synced, false if skipped or failed.
 */
export async function syncGoogleHoursToD1(
  db: D1Database,
  apiKey: string,
  placeId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'regularOpeningHours,currentOpeningHours',
        },
      },
    );

    if (!res.ok) {
      console.warn(`[sync-hours] Google Places API returned ${res.status}`);
      return false;
    }

    const data = await res.json() as {
      regularOpeningHours?: GoogleOpeningHours;
      currentOpeningHours?: GoogleOpeningHours;
    };

    const regular = data.regularOpeningHours;
    const current = data.currentOpeningHours;

    if (!regular?.periods?.length) {
      console.warn('[sync-hours] No opening hours data returned');
      return false;
    }

    // Build weekly schedule
    const dayMap = new Map<number, { open: string; close: string }>();
    for (const period of regular.periods) {
      const openTime = padTime(period.open.hour, period.open.minute);
      const closeTime = period.close
        ? padTime(period.close.hour, period.close.minute)
        : '23:59';
      dayMap.set(period.open.day, { open: openTime, close: closeTime });
    }

    const orderedDays = [1, 2, 3, 4, 5, 6, 0];
    const days = orderedDays.map(dayNum => {
      const times = dayMap.get(dayNum);
      return {
        day: DAY_NAMES[dayNum],
        open: times?.open ?? '00:00',
        close: times?.close ?? '00:00',
        closed: !times,
      };
    });

    // Detect holiday/special hours from currentOpeningHours.
    // specialDays lists dates with exceptional hours (e.g. Christmas).
    // Match each against currentOpeningHours.periods by calendar date;
    // if no period matches, the store is closed that day.
    const holidays: Array<{ date: string; label: string; closed: boolean; open: string; close: string }> = [];
    if (current?.specialDays) {
      for (const special of current.specialDays) {
        if (!special.date) continue;
        const dateStr = `${special.date.year}-${String(special.date.month).padStart(2, '0')}-${String(special.date.day).padStart(2, '0')}`;
        const d = new Date(dateStr + 'T12:00:00');
        const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        // Match by specific calendar date, not day-of-week
        const matchingPeriod = current.periods?.find(p =>
          p.open.date &&
          p.open.date.year === special.date!.year &&
          p.open.date.month === special.date!.month &&
          p.open.date.day === special.date!.day
        );

        if (matchingPeriod) {
          holidays.push({
            date: dateStr,
            label,
            closed: false,
            open: padTime(matchingPeriod.open.hour, matchingPeriod.open.minute),
            close: matchingPeriod.close
              ? padTime(matchingPeriod.close.hour, matchingPeriod.close.minute)
              : '23:59',
          });
        } else {
          // No period for this date → store is closed
          holidays.push({ date: dateStr, label, closed: true, open: '00:00', close: '00:00' });
        }
      }
    }

    const hoursData = { days, holidays, note: '' };

    await db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('settings:hours', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(JSON.stringify(hoursData)).run();

    console.log('[sync-hours] Google hours synced to D1');
    return true;
  } catch (err) {
    console.error('[sync-hours] Failed:', err);
    return false;
  }
}
