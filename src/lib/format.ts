/** Format an ISO date (YYYY-MM-DD) as e.g. "May 20, 2026". */
export function formatDate(iso: string): string {
  if (!iso) return "";
  // Parse as UTC noon to avoid timezone-related off-by-one-day shifts.
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Format US dollars as a currency string, e.g. 450 -> "$450.00". */
export function formatCurrency(dollars: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(dollars);
}
