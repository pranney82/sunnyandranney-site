/**
 * The charity's impact numbers, read from its own brand page
 * ===========================================================================
 * sunshineonaranneyday.com/branding/ shows Sunshine on a Ranney Day's room makeovers and
 * children served, auto-calculated from its records ("feel free to use them in press
 * materials"). The weekly build reads them there so the email never shows stale numbers.
 * Anything unexpected (a missing number, two different ones) is an error, not a guess.
 */

export const IMPACT_PAGE = 'https://sunshineonaranneyday.com/branding/';

/** { rooms, children } from the page's HTML, like { rooms: '295+', children: '208+' }. */
export function impactFromPage(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const read = (label) => {
    const found = [...new Set([...text.matchAll(new RegExp(`(\\d[\\d,]*\\+?) ${label}`, 'g'))].map((m) => m[1]))];
    if (found.length !== 1) throw new Error(`expected one "${label}" number on the page, found ${found.length ? found.join(', ') : 'none'}.`);
    return found[0];
  };
  return { rooms: read('Room Makeovers'), children: read('Children Served') };
}
