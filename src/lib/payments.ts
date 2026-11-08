import { formatCents } from './money';
import type { PaymentStatus } from './types';

/**
 * The bounds of one online dues payment (ADR 0025, #542), shared by the Pay
 * form and `POST /api/member/payments` so the two can never disagree.
 *
 * The maximum is a separate, lower cap than the ledger's `MAX_ENTRY_CENTS`:
 * it bounds what one homeowner can send in one checkout, not what the board
 * can record. Raise it here, in one place, if the association needs to.
 */
export const MIN_PAYMENT_CENTS = 100;
export const MAX_PAYMENT_CENTS = 1_000_000;

/**
 * A payment's stored status, as a homeowner reads it — never what the address
 * bar claims. `created` is deliberately neutral: the homeowner may have
 * finished on the provider's page (and its confirmation has not arrived yet)
 * or left it without paying, and nothing here can tell which. `pending` means
 * the provider has the payment and is settling it. An expired checkout reads
 * as canceled, which is what it was to the homeowner.
 */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  created: 'Not confirmed yet',
  pending: 'Processing',
  succeeded: 'Received',
  failed: 'Did not go through',
  canceled: 'Canceled',
  expired: 'Canceled',
};

/**
 * Why `amountCents` cannot be paid, in words a homeowner can act on, or
 * `null` when it can. Integer cents only: the form parses typed dollars with
 * `parseDollarsToCents` first, and the route takes the wire value as is.
 */
export function paymentAmountError(amountCents: unknown): string | null {
  if (
    typeof amountCents !== 'number' ||
    !Number.isSafeInteger(amountCents) ||
    amountCents < MIN_PAYMENT_CENTS
  )
    return PAYMENT_TOO_SMALL;
  if (amountCents > MAX_PAYMENT_CENTS) return PAYMENT_TOO_LARGE;
  return null;
}

/** The two refusals, for a caller that already knows which bound was missed. */
export const PAYMENT_TOO_SMALL = `A payment must be at least ${formatCents(MIN_PAYMENT_CENTS)}`;
export const PAYMENT_TOO_LARGE = `A single online payment can be at most ${formatCents(MAX_PAYMENT_CENTS)}; contact the board to pay more`;
