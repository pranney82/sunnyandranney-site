import type { APIRoute } from 'astro';
import { json, requireOwner } from '@/lib/admin-http';
import { STATE_COOKIE, VERIFIER_COOKIE, stateCookieOptions } from '@/lib/gusto/callback';
import { challengeFor, createVerifier } from '@/lib/gusto/mcp-oauth.mjs';
import { authorizeUrl, gustoConfig, redirectUriFor } from '@/lib/gusto/oauth.mjs';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const admin = requireOwner(context.locals);
  if (admin instanceof Response) return admin;

  const config = gustoConfig(context.locals.runtime.env);
  if (!config) return json({ error: 'Gusto is not set up.' }, 409);

  const state = crypto.randomUUID();
  context.cookies.set(STATE_COOKIE, state, stateCookieOptions(context.url));

  let codeChallenge: string | undefined;
  if (config.route === 'mcp') {
    const verifier = createVerifier();
    context.cookies.set(VERIFIER_COOKIE, verifier, stateCookieOptions(context.url));
    codeChallenge = await challengeFor(verifier);
  }
  return context.redirect(authorizeUrl(config, { state, redirectUri: redirectUriFor(context.url.origin), codeChallenge }));
};
