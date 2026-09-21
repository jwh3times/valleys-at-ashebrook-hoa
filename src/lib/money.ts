/**
 * Money, between what a person types and what the ledger stores.
 *
 * The ledger is integer cents (ADR 0025). A board member types dollars. The
 * conversion between them is the single most common place money goes wrong in
 * software, and it goes wrong in two ways that both look fine in testing:
 *
 * 1. **Floating point.** `Math.round(1.005 * 100)` is `100`, not `101`,
 *    because 1.005 is really 1.00499999999999989341858963598497211933. Every
 *    `parseFloat(x) * 100` in a money form is that bug waiting for the right
 *    input. So this parses the DIGITS and never multiplies a fraction: the
 *    dollars and the cents are separate integers from the start.
 * 2. **Blank becoming zero.** `Number('')` is `0`, so an empty field silently
 *    posts a zero-cent entry (AGENTS.md's blank-first rule). Blank is its own
 *    answer here, returned as a refusal rather than a number.
 */

export type MoneyParse =
  { ok: true; cents: number } | { ok: false; error: string };

/**
 * The largest single ledger entry, in cents: $1,000,000.
 *
 * It lives here rather than in the route so the form and the server agree on
 * one number and one vocabulary — the route imports it. It is a typo limit and
 * a type limit rather than a policy one: `Number.isInteger(1e21)` is true and
 * such a value is past SQLite's 64-bit INTEGER range, so it would land in the
 * ledger as a float.
 */
export const MAX_ENTRY_CENTS = 100_000_000;

/** Accepts `12`, `12.5`, `12.50`, `-12.50`, `1,234.56`, `$12.50`. */
const SHAPE = /^(-?)\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a typed amount into whole cents.
 *
 * Deliberately strict about what it accepts, because a money field is not a
 * place to guess: three decimal places is a typo, not a rounding request, and
 * a stray letter is a typo too. Both are refused rather than coerced.
 */
export function parseDollarsToCents(raw: string): MoneyParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Enter an amount' };

  const match = SHAPE.exec(trimmed);
  if (!match)
    return {
      ok: false,
      error:
        'Enter an amount in dollars and cents, such as 450 or 450.75 — no more than two decimal places',
    };

  const [, sign, dollarsRaw, centsRaw] = match;
  const dollars = Number(dollarsRaw.replace(/,/g, ''));
  // `.5` means fifty cents, not five. Pad rather than parse-and-scale, so no
  // fraction is ever multiplied.
  const cents = centsRaw === undefined ? 0 : Number(centsRaw.padEnd(2, '0'));
  if (!Number.isSafeInteger(dollars))
    return { ok: false, error: 'That amount is too large' };

  const total = dollars * 100 + cents;
  if (!Number.isSafeInteger(total))
    return { ok: false, error: 'That amount is too large' };
  // Zero is refused here rather than by the server, which would answer in the
  // wire's vocabulary ("amountCents cannot be zero") to someone who typed
  // dollars. A zero entry is not a fact anyone meant to record — the same
  // argument as blank, one step along.
  if (total === 0)
    return { ok: false, error: 'An amount of zero is not an entry' };
  if (total > MAX_ENTRY_CENTS)
    return {
      ok: false,
      error: `That is larger than a single entry may be ($${(MAX_ENTRY_CENTS / 100).toLocaleString('en-US')}) — check the decimal point`,
    };
  // `-total` where total is 0 would be `-0`, and every `x < 0` check
  // downstream silently disagrees with the minus that was typed. Zero is
  // refused above, so this cannot arise — the ternary states the invariant
  // rather than relying on it.
  return { ok: true, cents: sign === '-' && total !== 0 ? -total : total };
}

/**
 * Cents as a person reads them: `-4500` becomes `-$45.00`.
 *
 * The sign leads, because on a ledger a negative figure is a credit and
 * burying the minus inside the number is how a credit gets read as a debt.
 */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  const grouped = dollars.toLocaleString('en-US');
  return `${negative ? '-' : ''}$${grouped}.${String(remainder).padStart(2, '0')}`;
}

/** A balance, said the way a homeowner needs to hear it. */
export function describeBalance(cents: number): string {
  if (cents === 0) return 'Nothing owed';
  return cents > 0
    ? `${formatCents(cents)} owed`
    : `${formatCents(-cents)} in credit`;
}
