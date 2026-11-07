/** The OAuth `state` cookie ties the return from Gusto to the owner who started it. */
export const STATE_COOKIE = 'gusto_oauth_state';

/** PKCE proof for the same sign-in, sent only on Gusto's redirect back. */
export const VERIFIER_COOKIE = 'gusto_oauth_verifier';

export function stateCookieOptions(url: URL) {
  return {
    path: '/api/admin/gusto/',
    httpOnly: true,
    // Lax still arrives on Gusto's redirect back, and Strict would not.
    sameSite: 'lax' as const,
    secure: url.protocol === 'https:',
    maxAge: 600,
  };
}
