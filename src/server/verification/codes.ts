export const MAX_ATTEMPTS = 5;
export const CODE_TTL_MS = 600_000;

export function generateCode(): string {
  // Rejection sampling avoids the modulo bias of `random % 1_000_000`:
  // discard the top partial bucket so every 6-digit value is equally likely.
  const range = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  let n = crypto.getRandomValues(new Uint32Array(1))[0];
  while (n >= limit) {
    n = crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (n % range).toString().padStart(6, '0');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// Keyed HMAC-SHA-256 so a leaked D1 backup can't be reversed with a
// precomputed 1M-row rainbow table the way a bare SHA-256 digest can.
export async function hashCode(code: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(code),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Constant-time hex comparison: no early return on the first differing char,
// so verification time doesn't leak how much of the digest matched.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyCode(
  code: string,
  hash: string,
  secret: string,
): Promise<boolean> {
  return timingSafeEqualHex(await hashCode(code, secret), hash);
}
