// AES-GCM encrypted session cookies. Used for both the long-lived customer
// session and the short-lived pending-OAuth state during the authorize handshake.

export const SESSION_COOKIE = 'sr_session';
export const PENDING_COOKIE = 'sr_pending_auth';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
export const PENDING_MAX_AGE = 60 * 10; // 10 min

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  customerId: string;
  email?: string;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('sr-session-v1'),
      info: new Uint8Array(),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSession(data: unknown, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return base64UrlEncode(combined);
}

export async function decryptSession<T>(token: string, secret: string): Promise<T | null> {
  try {
    const combined = base64UrlDecode(token);
    const iv = combined.subarray(0, 12);
    const ciphertext = combined.subarray(12);
    const key = await deriveKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export function buildCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  const match = cookieHeader.match(re);
  return match ? match[1] : null;
}

export async function getSession(request: Request, secret: string): Promise<SessionData | null> {
  const cookieHeader = request.headers.get('Cookie');
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  return decryptSession<SessionData>(token, secret);
}

function base64UrlEncode(buf: Uint8Array): string {
  let str = '';
  for (const b of buf) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(str.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
