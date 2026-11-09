import { paymentInFlight } from '../../lib/payments';
import type { PaymentStatus } from '../../lib/types';
import { applyPaymentEvent, claimPaymentPull } from './apply';
import type { PaymentProvider } from './provider';

/**
 * A homeowner asks the site to check one payment with the provider (ADR 0025,
 * #544).
 *
 * The pull goes through `retrievePayment` and the application path, like the
 * daily job's, so a fact the webhook already recorded is stored once. The
 * provider is asked about one payment at most once a minute: `claimPaymentPull`
 * stamps the payment's `updated_at`, and a refresh inside the window asks
 * nothing. That bounds what an open return page, or a homeowner pressing
 * reload, can cost the association's provider account.
 */
export const REFRESH_EVERY_MS = 60 * 1000;

/**
 * Pulls one payment the caller has already been scoped to, and answers whether
 * the provider was asked. Only a payment still in flight is pulled: a pull
 * reports the checkout's own state, which for a settled, failed or canceled
 * payment is already stored, and what happens to money after it settles
 * (a refund, a dispute) arrives by webhook and the daily job. A provider error
 * propagates after the claim, so a failing provider is not asked again for
 * another minute either.
 */
export async function refreshPayment(
  env: Env,
  provider: PaymentProvider,
  payment: {
    id: string;
    status: PaymentStatus;
    providerPaymentRef: string | null;
  },
  now: Date,
): Promise<boolean> {
  const ref = payment.providerPaymentRef;
  if (!ref || !paymentInFlight(payment.status)) return false;
  if (
    !(await claimPaymentPull(
      env,
      payment.id,
      provider.id,
      now,
      REFRESH_EVERY_MS,
    ))
  )
    return false;
  for (const fact of await provider.retrievePayment(ref))
    await applyPaymentEvent(env, fact, now);
  return true;
}
