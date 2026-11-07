import type { APIRoute } from 'astro';
import { json, requireOwner } from '@/lib/admin-http';
import { STATE_COOKIE, VERIFIER_COOKIE, stateCookieOptions } from '@/lib/gusto/callback';
import { createGustoClient } from '@/lib/gusto/client.mjs';
import { saveConnection } from '@/lib/gusto/connection.mjs';
import { identifyCompany } from '@/lib/gusto/mcp-client.mjs';
import { GustoError, exchangeCode, gustoConfig, redirectUriFor, revokeToken } from '@/lib/gusto/oauth.mjs';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const admin = requireOwner(context.locals);
  if (admin instanceof Response) return admin;

  const config = gustoConfig(context.locals.runtime.env);
  if (!config) return json({ error: 'Gusto is not set up.' }, 409);

  const back = (error?: string) => context.redirect(`/admin/gusto/${error ? `?error=${error}` : ''}`);
  const params = context.url.searchParams;
  const expected = context.cookies.get(STATE_COOKIE)?.value;
  const codeVerifier = context.cookies.get(VERIFIER_COOKIE)?.value;
  context.cookies.delete(STATE_COOKIE, stateCookieOptions(context.url));
  context.cookies.delete(VERIFIER_COOKIE, stateCookieOptions(context.url));

  // Checked first and without exceptions: this is what stops someone tricking an
  // owner into connecting the site to the wrong Gusto company.
  if (!expected || params.get('state') !== expected) return back('state');
  if (params.get('error')) return back('denied');
  const code = params.get('code');
  if (!code) return back('failed');

  try {
    const redirectUri = redirectUriFor(context.url.origin);
    const tokens = await exchangeCode(config, { code, redirectUri, codeVerifier });

    if (config.route === 'mcp') {
      const company = await identifyCompany(config, tokens);
      if ('problem' in company) {
        // Don't leave behind a sign-in that nothing here will use. Gusto usually
        // refuses, so the page tells the owner how to remove it themselves.
        const revoked = await revokeToken(config, tokens.refreshToken);
        return back(revoked ? company.problem : `${company.problem}&leftover=1`);
      }
      await saveConnection(context.locals.runtime.env.DB, config, { tokens, ...company, redirectUri, actor: admin.email });
      return back();
    }

    const client = createGustoClient({ base: config.base, companyUuid: '', getToken: async () => tokens.accessToken });
    const info = await client.get('/v1/token_info');
    if (info?.resource?.type !== 'Company' || !info.resource.uuid) return back('company');

    const company = await client.get(`/v1/companies/${encodeURIComponent(info.resource.uuid)}`).catch(() => null);
    await saveConnection(context.locals.runtime.env.DB, config, {
      tokens,
      companyUuid: info.resource.uuid,
      companyName: company?.name ?? null,
      // The partner API route decides what it may do by its own app settings.
      scopes: null,
      redirectUri,
      actor: admin.email,
    });
    return back();
  } catch (err) {
    if (err instanceof GustoError) return back('failed');
    throw err;
  }
};
