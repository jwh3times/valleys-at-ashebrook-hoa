import type { PaymentProvider } from './provider';
import { ADAPTERS } from './providers';

let injected: PaymentProvider | null = null;

/**
 * Which payment provider this deployment uses (ADR 0025), or `null` — not
 * configured. Configured is ONE predicate, and this is it: `PAYMENTS_PROVIDER`
 * names a registered adapter AND both `PAYMENTS_API_KEY` and
 * `PAYMENTS_WEBHOOK_SECRET` are set. Anything less keeps every payment surface
 * absent, which is how production stays dark until a merchant account exists.
 *
 * Real adapters are registered in `providers/index.ts` and nowhere else, so
 * this module never names a provider.
 */
export function paymentProviderFor(env: Env): PaymentProvider | null {
  if (injected) return injected;
  const id = env.PAYMENTS_PROVIDER?.trim();
  const apiKey = env.PAYMENTS_API_KEY?.trim();
  const webhookSecret = env.PAYMENTS_WEBHOOK_SECRET?.trim();
  if (!id || !Object.hasOwn(ADAPTERS, id) || !apiKey || !webhookSecret)
    return null;
  return ADAPTERS[id]({ apiKey, webhookSecret });
}

/**
 * The test-only hook through which a suite injects its fake provider.
 *
 * The fake lives under the test tree and is never reachable through
 * `PAYMENTS_PROVIDER`, so no deployment can select it. This refuses to run
 * outside Vitest as well, so a stray production call cannot either.
 */
export function setPaymentProviderForTests(provider: PaymentProvider | null) {
  if (import.meta.env.MODE !== 'test')
    throw new Error('setPaymentProviderForTests is for tests only');
  injected = provider;
}
