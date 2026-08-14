// Address normalization shared by the runtime OTP matcher (lookup.ts) and the
// roster import script. Kept dependency-free so the script can import it under
// `node --experimental-strip-types` without pulling in the D1/schema chain.
export function normalizeAddress(raw: string): string {
  return raw.toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}

// Contact normalization for the ADR 0022 backfill and, from phase 3, for
// Automatic Person Verification's uniquely-attributable check.
//
// Legacy values are NOT consistently normalized: E.164 coercion and email
// lowercasing happen only in the roster import script, while the admin write
// path merely trims and length-caps. So two owner rows can hold the same
// address in different cases and nothing objects. Normalizing at migration is
// what makes cross-Party ambiguity detectable at all — otherwise a couple
// sharing one email in two casings migrates as two unambiguous contacts, and
// automatic verification silently stays available for a case that must require
// a human.

/** Lowercased and trimmed, or null when blank. No validation — legacy values
 * are accepted as recorded, and a malformed one simply never matches. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '')
    .trim()
    .toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** US ten-digit numbers as E.164, matching what Twilio's `To` requires. Any
 * other shape keeps its digits so two spellings of one number still collide,
 * which is the property the ambiguity check depends on. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits === '') return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** Lowercase, punctuation stripped, whitespace collapsed — the same shape the
 * two-tier name match will compare against a Lot's current owners. */
export function normalizeName(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '')
    .toLowerCase()
    .replace(/[.,'’-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed === '' ? null : trimmed;
}
