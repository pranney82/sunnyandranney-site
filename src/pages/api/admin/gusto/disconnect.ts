import type { APIRoute } from 'astro';
import { dbOf, json, requireOwner } from '@/lib/admin-http';
import { removeConnection } from '@/lib/gusto/connection.mjs';
import { gustoConfig } from '@/lib/gusto/oauth.mjs';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const admin = requireOwner(context.locals);
  if (admin instanceof Response) return admin;

  const config = gustoConfig(context.locals.runtime.env);
  if (!config) return json({ error: 'Gusto is not set up.' }, 409);

  const { revoked } = await removeConnection(dbOf(context), config);
  return json({ ok: true, revoked });
};
