/**
 * Kiosk PINs. A short PIN is not a password: it only stops one employee
 * clocking in for another. Hashing keeps PINs unreadable in the database, and
 * the clock endpoint rate limits guesses.
 */

// Cloudflare Workers caps PBKDF2 at 100,000 iterations.
const ITERATIONS = 100_000;

export const PIN_RE = /^\d{4,8}$/;

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function derive(pin, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((byte) => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return toHex(bits);
}

export async function hashPin(pin) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await derive(pin, salt) };
}

export async function verifyPin(pin, salt, hash) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin) || !salt || !hash) return false;
  const candidate = await derive(pin, salt);
  // Constant-time compare of equal-length hex strings.
  let difference = candidate.length ^ hash.length;
  for (let i = 0; i < candidate.length; i++) difference |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return difference === 0;
}
