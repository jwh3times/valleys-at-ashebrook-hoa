import { useState } from 'react';
import { centsAsTypedDollars, parseDollarsToCents } from '../../lib/money';
import {
  PAYMENT_TOO_LARGE,
  PAYMENT_TOO_SMALL,
  paymentAmountError,
} from '../../lib/payments';
import { startDuesPayment } from '../../lib/member';

// The Pay action beside one Lot's balance on `/lot-records` (ADR 0025, #542).
// The page renders it only when online payments are on and a provider is
// configured. It takes an amount, starts the payment, and sends the browser to
// the provider's hosted page; bank and card details are entered there, never
// here.
//
// The copy never ties a payment to a charge ("pays your March assessment"):
// the ledger is balance-forward, and how a payment is applied is the
// association's adopted order, not something this form may promise.

interface Props {
  lotId: string;
  /** The Lot's address, so each repeated control names its Lot. */
  address: string;
  /** The Lot's balance in cents; positive is owed. */
  balanceCents: number;
}

export default function PayDuesForm({ lotId, address, balanceCents }: Props) {
  const [amount, setAmount] = useState(
    balanceCents > 0 ? centsAsTypedDollars(balanceCents) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pay() {
    const parsed = parseDollarsToCents(amount);
    // A zero or an oversized amount is refused in this form's terms, not the
    // ledger's: a homeowner is paying, not posting an entry.
    if (!parsed.ok)
      return setError(
        parsed.reason === 'zero'
          ? PAYMENT_TOO_SMALL
          : parsed.reason === 'too_large'
            ? PAYMENT_TOO_LARGE
            : parsed.error,
      );
    const refused = paymentAmountError(parsed.cents);
    if (refused) return setError(refused);
    setError(null);
    setBusy(true);
    try {
      window.location.assign(await startDuesPayment(lotId, parsed.cents));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'The payment could not be started',
      );
      setBusy(false);
    }
  }

  return (
    <form
      className="panel-card"
      onSubmit={(e) => {
        e.preventDefault();
        void pay();
      }}
    >
      {error && (
        <div className="form-message form-message--error" role="alert">
          {error}
        </div>
      )}
      <div className="field">
        <label htmlFor={`pay-amount-${lotId}`}>Amount</label>
        <input
          id={`pay-amount-${lotId}`}
          aria-label={`Amount to pay: ${address}`}
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <p className="muted">
        A payment counts toward this lot’s balance. You enter your bank account
        or card on the payment provider’s secure page, not on this site.
      </p>
      <button
        type="submit"
        className="btn"
        disabled={busy}
        aria-label={`Continue to payment: ${address}`}
      >
        Continue to payment
      </button>
    </form>
  );
}
