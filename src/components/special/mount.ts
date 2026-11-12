import { h, hydrate } from 'preact';
import { toast } from '@/lib/admin/shell';
import SpecialApp, { type AppProps } from './SpecialApp';

/**
 * Takes over the special the server already drew. Not an Astro island: islands start
 * from an inline script, which the admin's CSP refuses. The component also renders on
 * the server, so it asks for toasts with an event instead of importing the shell.
 */
export function mountSpecial(): void {
  const root = document.getElementById('special-root');
  const data = document.getElementById('special-data');
  if (!root || !data?.textContent) return;
  document.addEventListener('admin:toast', (e) => {
    const { message, tone } = (e as CustomEvent<{ message: string; tone?: 'ok' | 'error' }>).detail;
    toast(message, tone);
  });
  hydrate(h(SpecialApp, JSON.parse(data.textContent) as AppProps), root);
}
