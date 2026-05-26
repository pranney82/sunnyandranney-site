export async function verifyShopifyHmac(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  const key = await importHmacKey(secret);
  const computed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  );

  const computedB64 = btoa(String.fromCharCode(...new Uint8Array(computed)));
  return timingSafeEqual(computedB64, signature);
}

// Shopify signs OAuth callback URLs with HMAC-SHA256 over the sorted query string
// (excluding `hmac` and `signature`), hex-encoded, using the app's client secret.
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant#step-3-verify-the-installation-request
export async function verifyOAuthCallbackHmac(
  url: URL,
  secret: string,
): Promise<boolean> {
  const provided = url.searchParams.get('hmac');
  if (!provided) return false;

  const params: string[] = [];
  for (const [k, v] of url.searchParams) {
    if (k === 'hmac' || k === 'signature') continue;
    params.push(`${k}=${v}`);
  }
  params.sort();
  const message = params.join('&');

  const key = await importHmacKey(secret);
  const computed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const computedHex = bytesToHex(new Uint8Array(computed));
  return timingSafeEqual(computedHex, provided);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
