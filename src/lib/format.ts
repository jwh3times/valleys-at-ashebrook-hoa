/** Format an ISO date string (YYYY-MM-DD) as a friendly long date. */
export function formatDate(iso: string): string {
  if (!iso) return '';
  // Treat as a local date (avoid timezone shifting a date-only string).
  const [y, m, d] = iso.split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Today's date as an ISO YYYY-MM-DD string (local time). */
export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The association's current calendar date in America/New_York. */
export function associationDateIso(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Display name for a Person, or the Roster Redaction fallback (#205).
 *
 * The fallback is a stable, non-identifying label derived from the durable
 * Party id — the SAME string on every surface for EVERY viewer, board
 * included. A privileged "formerly …" variant would defeat the mechanism:
 * redaction exists because a legal or policy obligation says the value must be
 * gone. Every read that renders a Person name goes through this function; a
 * surface with its own fallback is a bug.
 */
export function personDisplayLabel(
  fullName: string | null | undefined,
  partyId: string,
): string {
  return fullName ?? `Resident ${partyId.slice(0, 8)}`;
}

/**
 * Mask an email for display to a third party: keep the first character of the
 * local part and the full domain (`jerryholland00@gmail.com` → `j***@gmail.com`).
 * The `***` is fixed-width so it never leaks the local-part length. Anything
 * without a usable local part and domain masks entirely to `***`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const domain = email.slice(at + 1);
  if (!domain) return '***';
  return `${email[0]}***@${domain}`;
}
