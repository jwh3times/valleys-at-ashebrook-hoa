import { formatCents } from './money';
import type {
  PaymentEventOutcome,
  PaymentEventType,
  PaymentEventVia,
  PaymentExceptionReason,
  PaymentLedgerState,
  PaymentResolution,
  PaymentStatus,
} from './types';

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

/**
 * A payment's status as a homeowner reads it, with one override: a payment
 * the provider took back no longer counts, whatever its checkout status says.
 */
export function paymentStatusLabel(
  status: PaymentStatus,
  ledgerState: PaymentLedgerState,
): string {
  return ledgerState === 'withdrawn'
    ? 'Withdrawn'
    : PAYMENT_STATUS_LABELS[status];
}

/**
 * Whether a payment may still settle: the provider has not answered yet
 * (`created`) or is settling it (`pending`). These are the payments shown
 * above the Pay action, and the ones the return page keeps checking.
 */
export function paymentInFlight(status: PaymentStatus): boolean {
  return status === 'created' || status === 'pending';
}

/**
 * Why an exception opened, in the board's words (#538's user story 27), so a
 * board member knows what to look at before opening anything.
 */
export const PAYMENT_EXCEPTION_REASON_LABELS: Record<
  PaymentExceptionReason,
  string
> = {
  amount_mismatch: 'The amount paid differs from the amount asked',
  currency_mismatch: 'Paid in a currency other than US dollars',
  unmatched_payment: 'Money that matches no payment started on this site',
  funds_withdrawn: 'The money was taken back after it was credited',
  dispute_opened: 'The payer disputed the payment',
  partial_withdrawal: 'Part of the payment was taken back',
  withdrawal_without_credit: 'Money was taken back that was never credited',
  possible_duplicate: 'Looks like a check or payment already entered by hand',
  stale_pending: 'Still processing ten days after it started',
};

/** How an exception was closed, in the board's words. */
export const PAYMENT_RESOLUTION_LABELS: Record<PaymentResolution, string> = {
  reviewed_no_action: 'Reviewed — nothing to do',
  corrected_by_entry: 'Corrected with a ledger entry',
  applied_to_lot: 'Applied to a lot',
  funds_reinstated: 'The money came back',
  other: 'Other (see the note)',
};

/** What a provider fact said, in the board's words. */
export const PAYMENT_EVENT_TYPE_LABELS: Record<PaymentEventType, string> = {
  payment_pending: 'Processing',
  payment_succeeded: 'Paid',
  payment_failed: 'Failed',
  payment_canceled: 'Canceled',
  funds_withdrawn: 'Money taken back',
  funds_reinstated: 'Money returned',
  dispute_opened: 'Disputed',
};

/** How a fact reached the site. */
export const PAYMENT_EVENT_VIA_LABELS: Record<PaymentEventVia, string> = {
  webhook: 'sent by the provider',
  reconciliation: 'asked of the provider',
  board: 'applied by the board',
};

/** What recording a fact did. */
export const PAYMENT_EVENT_OUTCOME_LABELS: Record<PaymentEventOutcome, string> =
  {
    applied: 'recorded',
    duplicate_effect: 'already recorded',
    unmatched: 'matched no payment',
    exception: 'sent to the board',
  };
