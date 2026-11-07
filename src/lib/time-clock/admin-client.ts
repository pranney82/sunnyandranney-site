/**
 * POSTs JSON from an admin page.
 *
 * Every admin page script imports this on purpose. Astro inlines small scripts
 * that have no imports, and the admin's Content-Security-Policy blocks inline
 * scripts, so a page with its own standalone script would silently stop working.
 */
export async function post<T = unknown>(url: string, body: object): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (res.ok) return { data, error: null };
    return { data: null, error: data?.error ?? 'Something went wrong. Try again.' };
  } catch {
    return { data: null, error: 'Could not reach the server. Check the connection and try again.' };
  }
}
