export const MAX_ATTEMPTS = 5;
export const CODE_TTL_MS = 600_000;

export function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, '0');
}

export async function hashCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyCode(code: string, hash: string): Promise<boolean> {
  return (await hashCode(code)) === hash;
}
