// Constant-time string comparison: no early return on the first differing
// character, so the compare time doesn't leak how much of a secret matched.
// (Mirrors the hex-digest comparison in verification/codes.ts, generalized for
// arbitrary secrets such as the bootstrap header.)
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
