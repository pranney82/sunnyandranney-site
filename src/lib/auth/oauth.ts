// Shopify Customer Account API OAuth (Confidential client, PKCE-enhanced).
// Endpoints surfaced by Shopify admin → Headless → Customer Account API.

export const AUTHORIZE_URL = 'https://account.sunnyandranney.com/authentication/oauth/authorize';
export const TOKEN_URL = 'https://account.sunnyandranney.com/authentication/oauth/token';
export const LOGOUT_URL = 'https://account.sunnyandranney.com/authentication/logout';
export const REDIRECT_URI = 'https://sunnyandranney.com/api/auth/callback';
export const POST_LOGOUT_URI = 'https://sunnyandranney.com/';
export const SCOPES = 'openid email';

export interface PendingAuth {
  state: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
  iss: string;
  aud: string | string[];
  nonce?: string;
  exp: number;
  iat: number;
}

export function generatePendingAuth(returnTo: string): PendingAuth {
  return {
    state: randomBase64Url(32),
    codeVerifier: randomBase64Url(64),
    nonce: randomBase64Url(16),
    returnTo,
  };
}

export async function pkceChallenge(codeVerifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(hash));
}

export function buildAuthorizeUrl(
  clientId: string,
  pending: PendingAuth,
  codeChallenge: string,
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', pending.state);
  url.searchParams.set('nonce', pending.nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  // Shopify Customer Account API confidential-client token exchange requires:
  //   - `Origin` header matching the storefront origin
  //   - HTTP Basic auth header with client_id:client_secret (don't put secret in body)
  //   - grant_type, redirect_uri, code, code_verifier in form body
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('client_id', clientId);
  params.set('redirect_uri', REDIRECT_URI);
  params.set('code', code);
  params.set('code_verifier', codeVerifier);

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${basicAuth}`,
      Origin: 'https://sunnyandranney.com',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed [${res.status}]: ${err}`);
  }
  return (await res.json()) as TokenResponse;
}

export function parseIdToken(idToken: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid id_token format');
  const payloadB64 = parts[1];
  const padded = payloadB64
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(payloadB64.length / 4) * 4, '=');
  return JSON.parse(atob(padded)) as IdTokenClaims;
}

export function buildLogoutUrl(idToken: string): string {
  const url = new URL(LOGOUT_URL);
  url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('post_logout_redirect_uri', POST_LOGOUT_URI);
  return url.toString();
}

function randomBase64Url(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(buf: Uint8Array): string {
  let str = '';
  for (const b of buf) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
