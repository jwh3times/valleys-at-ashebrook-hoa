import type { PaymentEventType, PaymentEventVia } from '../../lib/types';

/**
 * The payment-provider seam (ADR 0025).
 *
 * A provider is an adapter under `providers/`, and this interface is all the
 * rest of the system knows about it. Nothing outside `providers/` imports a
 * provider's client or names a provider — `test/unit/payments-boundaries.test.ts`
 * pins that — so changing provider is an adapter and a configuration change,
 * never a schema, ledger, gate or board-surface change.
 */

/**
 * One verified fact from a provider, normalized. `type` is ADR 0025's
 * seven-value vocabulary; nothing provider-specific crosses this boundary.
 */
export interface NormalizedPaymentEvent {
  /** The adapter id, as `PAYMENTS_PROVIDER` names it. */
  provider: string;
  /**
   * Unique per provider. A pull synthesizes a STABLE id for each fact it
   * reports, so repeated pulls dedupe per event as well as per effect.
   */
  providerEventId: string;
  /** The provider's reference for the payment, matched to `payments`. */
  providerPaymentRef: string | null;
  type: PaymentEventType;
  /** A magnitude in integer cents. */
  amountCents: number;
  /** ISO 4217, any case; stored lower-case. */
  currency: string;
  /** The provider's time, which dates the ledger entry. */
  occurredAt: Date;
  via: PaymentEventVia;
}

export interface CheckoutRequest {
  paymentId: string;
  amountCents: number;
  returnUrl: string;
  cancelUrl: string;
}

/** The two secrets every adapter is built with, checked present by the registry. */
export interface AdapterSecrets {
  apiKey: string;
  webhookSecret: string;
}

export type WebhookParse =
  { ok: false } | { ok: true; events: NormalizedPaymentEvent[] };

export interface PaymentProvider {
  readonly id: string;
  /** A hosted checkout for one `payments` row; the client navigates to `url`. */
  createCheckout(
    input: CheckoutRequest,
  ): Promise<{ providerPaymentRef: string; url: string }>;
  /** Verify FIRST, then parse. An unverified request yields `{ ok: false }`. */
  verifyAndParseWebhook(
    request: Request,
    rawBody: string,
  ): Promise<WebhookParse>;
  /**
   * The payment's current state, as facts with stable ids, so a pull repeated
   * every day is stored once. `via` is `reconciliation`.
   */
  retrievePayment(
    providerPaymentRef: string,
  ): Promise<NormalizedPaymentEvent[]>;
  /**
   * Facts since an opaque cursor the adapter minted (`null`: as far back as the
   * provider keeps), oldest first, with the cursor the next call should pass.
   * `via` is `reconciliation`.
   */
  listEventsSince(
    cursor: string | null,
  ): Promise<{ events: NormalizedPaymentEvent[]; nextCursor: string | null }>;
}
