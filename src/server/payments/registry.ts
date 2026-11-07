import type { PaymentProvider } from './provider';

/**
 * Which payment provider this deployment uses (ADR 0025): the adapter whose id
 * `PAYMENTS_PROVIDER` names, or `null` — not configured — when it names none.
 *
 * Real adapters are registered here and nowhere else. There are none yet: the
 * first lands with the webhook (#541), so today every deployment resolves to
 * not configured, which is what keeps every payment surface absent.
 */
type AdapterFactory = (env: Env) => PaymentProvider;

const ADAPTERS: Readonly<Record<string, AdapterFactory>> = {};

let injected: PaymentProvider | null = null;

export function paymentProviderFor(env: Env): PaymentProvider | null {
  if (injected) return injected;
  const id = env.PAYMENTS_PROVIDER?.trim();
  if (!id || !Object.hasOwn(ADAPTERS, id)) return null;
  return ADAPTERS[id](env);
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
