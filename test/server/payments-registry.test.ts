import { env } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import {
  paymentProviderFor,
  setPaymentProviderForTests,
} from '../../src/server/payments/registry';
import { FAKE_PROVIDER_ID, fakeProvider } from './payments-fixtures';

/**
 * Which provider a deployment uses (ADR 0025, #539, #541). "Configured" is one
 * predicate: a registered adapter id AND both payment secrets. Anything less
 * resolves to not configured, which is what keeps every payment surface
 * absent — and the fake this suite injects must never be reachable through
 * configuration.
 */

afterEach(() => setPaymentProviderForTests(null));

const SECRETS = {
  PAYMENTS_API_KEY: 'sk_test_not_real',
  PAYMENTS_WEBHOOK_SECRET: 'whsec_not_real',
};

const withProvider = (
  value: string | undefined,
  secrets: Partial<Record<keyof typeof SECRETS, string>> = SECRETS,
): Env => ({
  ...env,
  PAYMENTS_API_KEY: undefined,
  PAYMENTS_WEBHOOK_SECRET: undefined,
  ...secrets,
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

  it('resolves the stripe adapter when its id and both secrets are set', () => {
    expect(paymentProviderFor(withProvider('stripe'))?.id).toBe('stripe');
    expect(paymentProviderFor(withProvider(' stripe '))?.id).toBe('stripe');
  });

  it.each([
    [
      'no API key',
      { PAYMENTS_WEBHOOK_SECRET: SECRETS.PAYMENTS_WEBHOOK_SECRET },
    ],
    ['no webhook secret', { PAYMENTS_API_KEY: SECRETS.PAYMENTS_API_KEY }],
    ['a blank API key', { ...SECRETS, PAYMENTS_API_KEY: '  ' }],
    ['a blank webhook secret', { ...SECRETS, PAYMENTS_WEBHOOK_SECRET: '' }],
  ])('is not configured with %s', (_, secrets) => {
    expect(paymentProviderFor(withProvider('stripe', secrets))).toBeNull();
  });

  it('answers with an injected provider, and stops once it is cleared', async () => {
    const fake = fakeProvider();
    setPaymentProviderForTests(fake);
    expect(paymentProviderFor(withProvider(undefined))).toBe(fake);

    const checkout = await fake.createCheckout({
      paymentId: 'pay-1',
      reference: 'PAY1-0000',
      amountCents: 45000,
      returnUrl: 'https://site.invalid/back',
      cancelUrl: 'https://site.invalid/cancel',
    });
    expect(checkout.providerPaymentRef).toBe('ref_pay-1');

    setPaymentProviderForTests(null);
    expect(paymentProviderFor(withProvider(undefined))).toBeNull();
  });
});
