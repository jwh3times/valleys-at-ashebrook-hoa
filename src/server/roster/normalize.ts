// Address normalization shared by the runtime OTP matcher (lookup.ts) and the
// roster import script. Kept dependency-free so the script can import it under
// `node --experimental-strip-types` without pulling in the D1/schema chain.
export function normalizeAddress(raw: string): string {
  return raw.toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}
