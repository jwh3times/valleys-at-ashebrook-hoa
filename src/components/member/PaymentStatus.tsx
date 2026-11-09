import { useEffect, useState } from 'react';
import { formatCents } from '../../lib/money';
import { paymentInFlight, paymentStatusLabel } from '../../lib/payments';
import { refreshDuesPayment } from '../../lib/member';
import type {
  PaymentLedgerState,
  PaymentStatus as Status,
} from '../../lib/types';

// One payment's status on the return page, `/lot-records/payments/[id]`
// (ADR 0025, #544).
//
// The page server-renders this with the payment's STORED status, so without
// JavaScript the homeowner still reads the truth and a link back. With it,
// while the payment may still settle (`created` or `pending`), the island asks
// the server to check with the provider, a bounded number of times, and shows
// whatever the server then holds. It never reads the address bar: the provider
// may append anything to the return address.

/**
 * The waits before each check, about three minutes in all. A card payment is
 * usually confirmed within the first few; a bank payment takes days, and no
 * amount of checking changes that. The server asks the provider at most once a
 * minute per payment, so the early checks mostly read what a webhook has
 * written meanwhile.
 */
export const REFRESH_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
];

interface Props {
  paymentId: string;
  amountCents: number;
  status: Status;
  ledgerState: PaymentLedgerState;
}

function explanation(status: Status, ledgerState: PaymentLedgerState): string {
  if (ledgerState === 'withdrawn')
    return 'The payment provider took this payment back, so it no longer counts toward your balance. The board has been told.';
  if (status === 'succeeded')
    return 'The payment provider has confirmed this payment, and it is on your lot’s account.';
  if (status === 'pending')
    return 'The payment provider has this payment and is processing it. It appears on your lot’s account once it is confirmed. You do not need to pay again.';
  if (status === 'created')
    return 'The payment provider has not confirmed this payment yet. If you finished paying, it will show here once they do. If you left the payment page without finishing, nothing was taken, and the payment is canceled within the hour.';
  return 'No money was taken for this payment. You can start a new one from your lot records.';
}

export default function PaymentStatus({
  paymentId,
  amountCents,
  status: storedStatus,
  ledgerState: storedLedgerState,
}: Props) {
  const [state, setState] = useState({
    status: storedStatus,
    ledgerState: storedLedgerState,
  });
  const [tries, setTries] = useState(0);
  const inFlight = paymentInFlight(state.status);
  const stopped = inFlight && tries >= REFRESH_DELAYS_MS.length;

  // Polling, not the documented mount-fetch shape: each try is one timer, and
  // the next is scheduled by the try count changing. `check` is declared
  // inside the callback, so the lint's set-state-in-effect check does not see
  // it; every state write here comes after the `await`, behind `cancelled`.
  useEffect(() => {
    if (!inFlight || tries >= REFRESH_DELAYS_MS.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      async function check() {
        try {
          const next = await refreshDuesPayment(paymentId);
          if (!cancelled)
            setState({ status: next.status, ledgerState: next.ledgerState });
        } catch {
          // A failed check is one of the tries; the next one may succeed.
        }
        if (!cancelled) setTries((count) => count + 1);
      }
      void check();
    }, REFRESH_DELAYS_MS[tries]);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inFlight, tries, paymentId]);

  return (
    <>
      <p className="lot-record__balance">
        {formatCents(amountCents)} &middot;{' '}
        {paymentStatusLabel(state.status, state.ledgerState)}
      </p>
      <p role="status">{explanation(state.status, state.ledgerState)}</p>
      {inFlight && (
        <p className="muted">
          Bank payments take several business days to settle; card payments are
          usually confirmed within minutes.
        </p>
      )}
      {stopped && (
        <p className="muted">
          This page has stopped checking for now. Reload it later, or look at
          your lot records: the payment is updated there once the provider
          confirms it.
        </p>
      )}
    </>
  );
}
