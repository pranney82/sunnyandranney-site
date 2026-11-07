import type { APIContext } from 'astro';
import type { AdminIdentity, AdminRole } from '@/lib/admin-auth';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Second gate behind the middleware. Handlers call this first, so a route the
 * middleware somehow missed still fails closed, because locals.admin is unset.
 */
export function requireRole(locals: App.Locals, ...roles: AdminRole[]): AdminIdentity | Response {
  const admin = locals.admin;
  if (!admin || !roles.includes(admin.role)) return json({ error: 'Not authorized' }, 403);
  return admin;
}

export function requireOwner(locals: App.Locals): AdminIdentity | Response {
  const admin = locals.admin;
  if (!admin?.owner) return json({ error: 'Not authorized' }, 403);
  return admin;
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function dbOf(context: Pick<APIContext, 'locals'>): D1Database {
  return context.locals.runtime.env.DB;
}
