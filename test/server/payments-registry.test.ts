import { env } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import {
  paymentProviderFor,
  setPaymentProviderForTests,
} from '../../src/server/payments/registry';
import { FAKE_PROVIDER_ID, fakeProvider } from './payments-fixtures';

/**
 * Which provider a deployment uses (ADR 0025, #539). Until the first real
 * adapter lands (#541) every deployment is unconfigured, which is what keeps
 * every payment surface absent — and the fake this suite injects must never be
 * reachable through configuration.
 */

afterEach(() => setPaymentProviderForTests(null));

const withProvider = (value: string | undefined): Env => ({
  ...env,
  PAYMENTS_PROVIDER: value,
});

describe('the payment provider registry', () => {
  it('is not configured when PAYMENTS_PROVIDER is unset or blank', () => {
    expect(paymentProviderFor(withProvider(undefined))).toBeNull();
    expect(paymentProviderFor(withProvider('   '))).toBeNull();
  });

  it('is not configured when PAYMENTS_PROVIDER names no registered adapter', () => {
    expect(paymentProviderFor(withProvider('no-such-adapter'))).toBeNull();
  });

  it('never resolves the test fake through configuration', () => {
    expect(paymentProviderFor(withProvider(FAKE_PROVIDER_ID))).toBeNull();
  });

  it('does not resolve inherited object keys as adapter ids', () => {
    expect(paymentProviderFor(withProvider('toString'))).toBeNull();
    expect(paymentProviderFor(withProvider('__proto__'))).toBeNull();
  });

  it('answers with an injected provider, and stops once it is cleared', async () => {
    const fake = fakeProvider();
    setPaymentProviderForTests(fake);
    expect(paymentProviderFor(withProvider(undefined))).toBe(fake);

    const checkout = await fake.createCheckout({
      paymentId: 'pay-1',
      amountCents: 45000,
      returnUrl: 'https://site.invalid/back',
      cancelUrl: 'https://site.invalid/cancel',
    });
    expect(checkout.providerPaymentRef).toBe('ref_pay-1');

    setPaymentProviderForTests(null);
    expect(paymentProviderFor(withProvider(undefined))).toBeNull();
  });
});
