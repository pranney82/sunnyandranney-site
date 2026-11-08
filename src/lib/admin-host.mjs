/**
 * The admin lives at its own address, admin.sunnyandranney.com. Cloudflare
 * Access guards that whole host. The store's own addresses skip Cloudflare's
 * proxy, so Access can't guard them, and the admin there would only ever
 * refuse everyone.
 */
export const ADMIN_HOST = 'admin.sunnyandranney.com';
const STORE_HOSTS = new Set(['sunnyandranney.com', 'www.sunnyandranney.com']);
const ADMIN_PATH = /^\/(api\/)?admin(\/|$)/i;

/**
 * Where to send a request instead, or null to handle it here.
 * - The admin host opens on the admin. Prebuilt pages, the home page included,
 *   never reach this code, so a zone redirect rule covers `/` on that host.
 * - An admin page asked for on a store address goes to the admin host.
 * API calls and form posts are never redirected; they get the usual refusal.
 */
export function adminHostRedirect(url, method) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const host = url.hostname.toLowerCase();
  const isAdminPath = ADMIN_PATH.test(url.pathname);
  if (host === ADMIN_HOST) return isAdminPath ? null : `https://${ADMIN_HOST}/admin/`;
  if (STORE_HOSTS.has(host) && isAdminPath && !url.pathname.toLowerCase().startsWith('/api/')) {
    return `https://${ADMIN_HOST}${url.pathname}${url.search}`;
  }
  return null;
}
