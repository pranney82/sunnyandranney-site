import { h, hydrate } from 'preact';
import ScheduleApp, { type AppProps } from './ScheduleApp';

/**
 * Takes over the schedule the server already drew. Not an Astro island:
 * islands start from an inline script, which the admin's CSP refuses.
 */
export function mountSchedule(): void {
  const root = document.getElementById('schedule-root');
  const data = document.getElementById('schedule-data');
  if (!root || !data?.textContent) return;
  const props = JSON.parse(data.textContent) as AppProps;
  hydrate(h(ScheduleApp, props), root);
}
