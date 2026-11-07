/**
 * Encrypts Gusto tokens before they reach D1, using GUSTO_TOKEN_KEY: 32 random
 * bytes in base64, from `openssl rand -base64 32`. A database leak alone then
 * gives nobody access to payroll.
 */
const ALGORITHM = 'AES-GCM';
const VERSION = 'v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function importKey(base64Key) {
  const raw = fromBase64(base64Key ?? '');
  if (raw.length !== 32) throw new Error('GUSTO_TOKEN_KEY must be 32 random bytes in base64');
  return crypto.subtle.importKey('raw', raw, ALGORITHM, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(plain, base64Key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, await importKey(base64Key), encoder.encode(plain));
  return [VERSION, toBase64(iv), toBase64(new Uint8Array(sealed))].join('.');
}

/** Throws if the value was tampered with or the key is wrong. */
export async function decryptToken(sealed, base64Key) {
  const [version, iv, data] = String(sealed).split('.');
  if (version !== VERSION || !iv || !data) throw new Error('Unreadable Gusto token');
  const plain = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: fromBase64(iv) },
    await importKey(base64Key),
    fromBase64(data),
  );
  return decoder.decode(plain);
}
