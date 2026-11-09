import type { APIRoute } from 'astro';
import { dbOf, json, requireRole } from '@/lib/admin-http';

export const prerender = false;

/** Store people by name, for the admin's ⌘K search. */
export const GET: APIRoute = async (context) => {
  const admin = requireRole(context.locals, 'manager');
  if (admin instanceof Response) return admin;

  const { results } = await dbOf(context)
    .prepare(
      `SELECT id, display_name AS name FROM staff
       WHERE gusto_terminated = 0 AND (store_staff = 1 OR gusto_employee_uuid IS NULL)
       ORDER BY display_name`,
    )
    .all<{ id: string; name: string }>();
  return json({ people: results });
};
