export const prerender = false;

import type { APIRoute } from 'astro';
import { json, readJson, requireOwner } from '@/lib/admin-http';
import { MedusaProblem, medusaJson } from '@/lib/medusa-admin';

/**
 * The owner chooses which Zeffy form the register's gifts go to, and so the QR
 * link a register shows for a gift with nothing bought. Owner only: it decides
 * where the charity's gifts are recorded. Recorded under the owner's email.
 */
export const POST: APIRoute = async (context) => {
  const admin = requireOwner(context.locals);
  if (admin instanceof Response) return admin;
  const body = await readJson(context.request);
  const campaign = typeof body?.campaign_id === 'string' ? body.campaign_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(campaign)) return json({ error: 'Choose a form' }, 400);
  try {
    const saved = await medusaJson<{ current: unknown }>(context.locals.runtime.env, 'giving/zeffy', {
      method: 'POST',
      body: { campaign_id: campaign, staff_id: admin.email, store_only: body?.store_only === true },
    });
    return json(saved);
  } catch (err) {
    if (err instanceof MedusaProblem) return json({ error: err.message }, err.status);
    throw err;
  }
};
