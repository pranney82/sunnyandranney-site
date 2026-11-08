import type { APIRoute } from 'astro';
import contact from '@/content/settings/contact.json';
import {
  buildCalendar,
  cellKey,
  cellsFromSnapshot,
  hoursOn,
  localToUtc,
  shiftShort,
  TIME_OFF_LABELS,
  weekDates,
} from '@/lib/schedule/core.mjs';
import { CALENDAR_TOKEN_RE, feedFor } from '@/lib/schedule/store';

export const prerender = false;

/**
 * One person's published shifts as a calendar their phone subscribes to. The
 * link's secret is the only key, like a private calendar address in Google
 * Calendar. It lives on the store's address rather than the admin's, because
 * Cloudflare Access guards the admin host and a calendar app can't sign in.
 * Only published weeks appear, so a half-built week never reaches a phone.
 */

const ADDRESS = `${contact.address}, ${contact.city}, ${contact.state} ${contact.zip}`;

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

export const GET: APIRoute = async ({ params, locals }) => {
  const token = params.token ?? '';
  if (!CALENDAR_TOKEN_RE.test(token)) return notFound();

  const data = await feedFor(locals.runtime.env.DB, token);
  if (!data) return notFound();

  const events: Parameters<typeof buildCalendar>[0]['events'] = [];
  for (const week of data.weeks) {
    const cells = cellsFromSnapshot(week.snapshot);
    const sequence = Math.floor(Date.parse(week.publishedAt) / 1000);
    for (const date of weekDates(week.weekStart)) {
      const mine = cells.get(cellKey(data.staffId, date));
      if (!mine) continue;
      const day = data.days.get(date);
      const hours = hoursOn(date, data.storeHours, day ?? null);

      if (mine.shift) {
        const shift = mine.shift;
        const coworkers = [...cells.entries()]
          .filter(([key, cell]) => key.endsWith(`|${date}`) && !key.startsWith(`${data.staffId}|`) && cell.shift)
          .map(([key, cell]) => `${data.names.get(key.split('|')[0]) ?? 'Someone'} ${shiftShort(cell.shift)}`);
        const description = [
          coworkers.length ? `Also working: ${coworkers.join(', ')}` : 'Nobody else is scheduled.',
          day?.note ? `Note: ${day.note}` : '',
          'This calendar follows the published schedule at Sunny & Ranney.',
        ]
          .filter(Boolean)
          .join('\n');
        const what = shift.label ? `${shift.label} ` : '';

        if (shift.start === null) {
          // A task with no hours yet ("Mart") shows as an all-day event.
          events.push({
            uid: `${date}-${data.staffId}@schedule.sunnyandranney.com`,
            date,
            summary: `Sunny & Ranney · ${shift.label}`,
            description,
            sequence,
          });
        } else {
          const fallbackEnd = hours && hours.close > shift.start ? hours.close : Math.min(shift.start + 240, 1440);
          const start = localToUtc(date, shift.start);
          const end = localToUtc(date, shift.end ?? fallbackEnd);
          if (start && end) {
            events.push({
              uid: `${date}-${data.staffId}@schedule.sunnyandranney.com`,
              start,
              end,
              summary: `Sunny & Ranney · ${what}${shiftShort(shift)}${shift.end === null ? ' (end time not set)' : ''}`,
              description,
              location: shift.away ? undefined : ADDRESS,
              sequence,
            });
          }
        }
      }

      if (mine.off) {
        const kind = mine.off.kind as keyof typeof TIME_OFF_LABELS;
        events.push({
          uid: `${date}-${data.staffId}-off@schedule.sunnyandranney.com`,
          date,
          summary: `${kind === 'off' ? 'Day off' : `Off work · ${TIME_OFF_LABELS[kind]}`}${mine.off.note ? ` · ${mine.off.note}` : ''}`,
          sequence,
        });
      }
    }
  }

  const body = buildCalendar({ name: 'Sunny & Ranney schedule', now: new Date().toISOString(), events });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="sunny-and-ranney-schedule.ics"',
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    },
  });
};
