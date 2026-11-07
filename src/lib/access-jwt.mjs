/**
 * Verifies the JWT Cloudflare Access attaches to each request.
 *
 * Access at the edge is not enough on its own: the same app is reachable on its
 * *.pages.dev hostname, where the custom-domain policy does not apply. Without
 * this check, those URLs would serve the admin to anyone.
 */

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

/**
 * @param {string | null} token
 * @param {{
 *   teamDomain: string,
 *   audience: string,
 *   getKeys: (kid: string) => Promise<Array<JsonWebKey & { kid?: string }>>,
 *   nowSeconds?: number,
 * }} options
 * @returns {Promise<{ email: string } | null>} null on any failure, never throws
 */
export async function verifyAccessJwt(token, { teamDomain, audience, getKeys, nowSeconds }) {
  if (!token || !teamDomain || !audience) return null;

  try {
    const segments = token.split('.');
    if (segments.length !== 3) return null;
    const [headerSegment, payloadSegment, signatureSegment] = segments;

    const header = decodeJson(headerSegment);
    // Pinned so a token cannot pick a weaker algorithm for itself.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const jwk = (await getKeys(header.kid)).find((key) => key.kid === header.kid);
    if (!jwk) return null;

    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);
    const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
    const valid = await crypto.subtle.verify(algorithm, key, base64UrlToBytes(signatureSegment), signed);
    if (!valid) return null;

    const payload = decodeJson(payloadSegment);
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

    if (payload.iss !== `https://${teamDomain}`) return null;
    if (!audiences.includes(audience)) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now) return null;
    // Service tokens have no email, so they can never reach a role.
    if (typeof payload.email !== 'string' || !payload.email) return null;

    return { email: payload.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}
