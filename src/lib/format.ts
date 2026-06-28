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
