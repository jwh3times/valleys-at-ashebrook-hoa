import type { AdapterSecrets, PaymentProvider } from '../provider';
import { STRIPE_PROVIDER_ID, stripeProvider } from './stripe';

/**
 * Every real payment adapter, by the id `PAYMENTS_PROVIDER` names. This is the
 * one list `registry.ts` reads, and it lives inside the adapter directory so
 * that nothing outside it names a provider (ADR 0025;
 * `test/unit/payments-boundaries.test.ts`).
 *
 * A factory runs only once the registry has checked that both payment secrets
 * are set, so it may rely on them.
 */
export type AdapterFactory = (secrets: AdapterSecrets) => PaymentProvider;

export const ADAPTERS: Readonly<Record<string, AdapterFactory>> = {
  [STRIPE_PROVIDER_ID]: stripeProvider,
};
