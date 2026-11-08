import { describe, it, expect, afterEach, vi } from 'vitest';
import { stripeProvider } from '../../src/server/payments/providers/stripe';
import type { WebhookParse } from '../../src/server/payments/provider';
import { urlOf } from './drive-fixtures';
import { stripeSignature } from './payments-fixtures';

/**
 * The Stripe adapter (ADR 0025, #541), with `fetch` stubbed as the Drive tests
 * do and fixtures shaped like Stripe's documented objects. Synthetic values
 * only: no key, secret or id here is real.
 */

const SECRET = 'whsec_test_secret_not_real';
const API_KEY = 'sk_test_key_not_real';
const NOW_S = 1_762_500_000; // 2025-11-07T07:20:00Z
const clock =
  (seconds = NOW_S) =>
  () =>
    seconds * 1000;

const adapter = (now = clock()) =>
  stripeProvider({ apiKey: API_KEY, webhookSecret: SECRET }, now);

afterEach(() => vi.unstubAllGlobals());

/** A POST to the webhook with these headers and this raw body. */
const webhookRequest = (headers: Record<string, string>, body: string) =>
  new Request('https://site.invalid/api/webhooks/payments', {
    method: 'POST',
    headers,
    body,
  });

/** A delivery as Stripe sends it: the raw body and its signature header. */
async function delivery(
  body: string,
  {
    t = NOW_S,
    secret = SECRET,
    header,
  }: { t?: number; secret?: string; header?: (sig: string) => string } = {},
) {
  const { v1: sig } = await stripeSignature(secret, body, t);
  const signature = header ? header(sig) : `t=${t},v1=${sig}`;
  return webhookRequest(
    {
      'content-type': 'application/json; charset=utf-8',
      'stripe-signature': signature,
    },
    body,
  );
}

/** An event type the adapter does not map: verification alone decides. */
const UNMAPPED = JSON.stringify({
  id: 'evt_unmapped',
  object: 'event',
  type: 'customer.created',
  created: NOW_S,
  data: { object: { id: 'cus_1', object: 'customer' } },
});

const verified = (result: WebhookParse) => result.ok;

describe('Stripe webhook signature verification', () => {
  it('accepts a delivery signed with the webhook secret', async () => {
    const req = await delivery(UNMAPPED);
    expect(await adapter().verifyAndParseWebhook(req, UNMAPPED)).toEqual({
      ok: true,
      events: [],
    });
  });

  it("accepts Stripe's documented scheme, checked against an independent HMAC", async () => {
    // Computed with `openssl dgst -sha256 -hmac`, not by this suite.
    const body =
      '{"id":"evt_vector","object":"event","type":"customer.created","created":1762500000,"data":{"object":{"id":"cus_1"}}}';
    const req = webhookRequest(
      {
        'stripe-signature':
          't=1762500000,v1=9b92b2cde751913dbf35eb54c7a8b12831d274433a607689edb3f63e535be592',
      },
      body,
    );
    const provider = stripeProvider(
      { apiKey: API_KEY, webhookSecret: 'whsec_vector_secret_not_real' },
      clock(),
    );
    expect(verified(await provider.verifyAndParseWebhook(req, body))).toBe(
      true,
    );
  });

  it('refuses a delivery signed with another secret', async () => {
    const req = await delivery(UNMAPPED, { secret: 'whsec_someone_else' });
    expect(await adapter().verifyAndParseWebhook(req, UNMAPPED)).toEqual({
      ok: false,
    });
  });

  it('refuses a body changed after signing', async () => {
    const req = await delivery(UNMAPPED);
    const tampered = UNMAPPED.replace('cus_1', 'cus_2');
    expect(verified(await adapter().verifyAndParseWebhook(req, tampered))).toBe(
      false,
    );
  });

  it('ignores every scheme but v1', async () => {
    const v0Only = await delivery(UNMAPPED, {
      header: (sig) => `t=${NOW_S},v0=${sig}`,
    });
    expect(
      verified(await adapter().verifyAndParseWebhook(v0Only, UNMAPPED)),
    ).toBe(false);
  });

  it('accepts any one valid v1 among several, as during a secret roll', async () => {
    const req = await delivery(UNMAPPED, {
      header: (sig) => `t=${NOW_S},v1=${'0'.repeat(64)},v0=abc,v1=${sig}`,
    });
    expect(verified(await adapter().verifyAndParseWebhook(req, UNMAPPED))).toBe(
      true,
    );
  });

  it('refuses a timestamp more than five minutes old', async () => {
    const stale = await delivery(UNMAPPED, { t: NOW_S - 301 });
    expect(
      verified(await adapter().verifyAndParseWebhook(stale, UNMAPPED)),
    ).toBe(false);
    const fresh = await delivery(UNMAPPED, { t: NOW_S - 299 });
    expect(
      verified(await adapter().verifyAndParseWebhook(fresh, UNMAPPED)),
    ).toBe(true);
  });

  it('refuses a timestamp more than five minutes ahead', async () => {
    const ahead = await delivery(UNMAPPED, { t: NOW_S + 301 });
    expect(
      verified(await adapter().verifyAndParseWebhook(ahead, UNMAPPED)),
    ).toBe(false);
  });

  it.each([
    ['no signature header', null],
    ['an empty header', ''],
    ['no timestamp', 'v1=abc'],
    ['no signature', `t=${NOW_S}`],
    ['a non-numeric timestamp', 't=soon,v1=abc'],
    ['a signature that is not hex', `t=${NOW_S},v1=${'z'.repeat(64)}`],
  ])('refuses %s', async (_, header) => {
    const req = webhookRequest(
      header === null ? {} : { 'stripe-signature': header },
      UNMAPPED,
    );
    expect(await adapter().verifyAndParseWebhook(req, UNMAPPED)).toEqual({
      ok: false,
    });
  });

  it('fails, rather than calling it unsigned, on a verified body that is not JSON', async () => {
    // Signed means Stripe sent it, so the fault is in reading it: a failure
    // the route answers 500 to, so Stripe retries once the fault is fixed.
    const body = 'not json';
    const req = await delivery(body);
    await expect(adapter().verifyAndParseWebhook(req, body)).rejects.toThrow();
  });

  it('never calls Stripe to verify a delivery', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const req = await delivery(UNMAPPED);
    await adapter().verifyAndParseWebhook(req, UNMAPPED);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- mapping

const SESSION_ID = 'cs_test_a1b2c3';
const INTENT_ID = 'pi_test_a1b2c3';

/** A Checkout Session, as Stripe's API reference documents the object. */
const session = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  object: 'checkout.session',
  amount_total: 45000,
  currency: 'usd',
  client_reference_id: 'pay-1',
  metadata: { payment_id: 'pay-1' },
  mode: 'payment',
  payment_intent: INTENT_ID,
  payment_status: 'paid',
  status: 'complete',
  ...overrides,
});

const dispute = (overrides: Record<string, unknown> = {}) => ({
  id: 'dp_test_1',
  object: 'dispute',
  amount: 45000,
  currency: 'usd',
  charge: 'ch_test_1',
  payment_intent: INTENT_ID,
  reason: 'insufficient_funds',
  status: 'needs_response',
  ...overrides,
});

/** A charge partly refunded, as `charge.refunded` reports it. */
const charge = (overrides: Record<string, unknown> = {}) => ({
  id: 'ch_test_1',
  object: 'charge',
  amount: 45000,
  amount_refunded: 20000,
  currency: 'usd',
  payment_intent: INTENT_ID,
  refunded: false,
  ...overrides,
});

const refund = (overrides: Record<string, unknown> = {}) => ({
  id: 're_test_1',
  object: 'refund',
  amount: 45000,
  currency: 'usd',
  charge: 'ch_test_1',
  payment_intent: INTENT_ID,
  status: 'succeeded',
  ...overrides,
});

const event = (type: string, object: unknown, id = 'evt_test_1') =>
  JSON.stringify({
    id,
    object: 'event',
    api_version: '2026-10-28.endive',
    created: NOW_S - 30,
    livemode: false,
    type,
    data: { object },
  });

const normalized = (type: string, overrides: Record<string, unknown> = {}) => ({
  provider: 'stripe',
  providerEventId: 'evt_test_1',
  providerPaymentRef: SESSION_ID,
  type,
  amountCents: 45000,
  currency: 'usd',
  occurredAt: new Date((NOW_S - 30) * 1000),
  via: 'webhook',
  ...overrides,
});

/** Stripe's list-Checkout-Sessions answer, and the requests that asked it. */
function stubSessionList(sessions: unknown[] = [session()]) {
  const calls: { url: string; headers: Headers; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: urlOf(input),
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
      });
      return Response.json({
        object: 'list',
        data: sessions,
        has_more: false,
        url: '/v1/checkout/sessions',
      });
    }),
  );
  return calls;
}

async function parse(body: string) {
  return adapter().verifyAndParseWebhook(await delivery(body), body);
}

describe('Stripe events, normalized', () => {
  it.each([
    ['checkout.session.completed', session(), 'payment_succeeded'],
    [
      'checkout.session.completed',
      session({ payment_status: 'unpaid' }),
      'payment_pending',
    ],
    [
      'checkout.session.async_payment_succeeded',
      session(),
      'payment_succeeded',
    ],
    [
      'checkout.session.async_payment_failed',
      session({ payment_status: 'unpaid' }),
      'payment_failed',
    ],
    [
      'checkout.session.expired',
      session({ payment_status: 'unpaid', status: 'expired' }),
      'payment_canceled',
    ],
  ])('maps %s (%#) without calling Stripe', async (type, object, expected) => {
    const calls = stubSessionList();
    expect(await parse(event(type, object))).toEqual({
      ok: true,
      events: [normalized(expected)],
    });
    expect(calls).toEqual([]);
  });

  it('takes the amount and currency the session reports', async () => {
    stubSessionList();
    const body = event(
      'checkout.session.completed',
      session({ amount_total: 12345, currency: 'USD' }),
    );
    expect(await parse(body)).toEqual({
      ok: true,
      events: [
        normalized('payment_succeeded', {
          amountCents: 12345,
          currency: 'USD',
        }),
      ],
    });
  });

  it('maps a completed session that needed no payment to nothing', async () => {
    stubSessionList();
    const body = event(
      'checkout.session.completed',
      session({ payment_status: 'no_payment_required' }),
    );
    expect(await parse(body)).toEqual({ ok: true, events: [] });
  });

  it.each([
    ['charge.dispute.created', dispute(), 'dispute_opened', 45000],
    ['charge.dispute.funds_withdrawn', dispute(), 'funds_withdrawn', 45000],
    ['charge.dispute.funds_reinstated', dispute(), 'funds_reinstated', 45000],
    ['refund.created', refund({ amount: 20000 }), 'funds_withdrawn', 20000],
    [
      'refund.failed',
      refund({ amount: 20000, status: 'failed' }),
      'funds_reinstated',
      20000,
    ],
  ])(
    'maps %s to its Checkout Session through the payment intent',
    async (type, object, expected, amountCents) => {
      const calls = stubSessionList();
      expect(await parse(event(type, object))).toEqual({
        ok: true,
        events: [normalized(expected, { amountCents })],
      });
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0].url);
      expect(url.origin + url.pathname).toBe(
        'https://api.stripe.com/v1/checkout/sessions',
      );
      expect(url.searchParams.get('payment_intent')).toBe(INTENT_ID);
      expect(calls[0].method).toBe('GET');
      expect(calls[0].headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
      expect(calls[0].headers.get('stripe-version')).toBe('2026-10-28.endive');
    },
  );

  it('reports a charge fact whose session Stripe cannot find as unmatched', async () => {
    stubSessionList([]);
    expect(await parse(event('charge.dispute.created', dispute()))).toEqual({
      ok: true,
      events: [normalized('dispute_opened', { providerPaymentRef: null })],
    });
  });

  it('reports a charge fact with no payment intent as unmatched, without asking Stripe', async () => {
    const calls = stubSessionList();
    expect(
      await parse(
        event('charge.dispute.created', dispute({ payment_intent: null })),
      ),
    ).toEqual({
      ok: true,
      events: [normalized('dispute_opened', { providerPaymentRef: null })],
    });
    expect(calls).toEqual([]);
  });

  it('fails, so Stripe retries, when the session lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{}}', { status: 500 })),
    );
    await expect(
      parse(event('charge.dispute.funds_withdrawn', dispute())),
    ).rejects.toThrow();
  });

  it('maps charge.refunded to nothing, so a refund is counted once, by refund.created', async () => {
    // Its amount_refunded is the charge's running total; counting it as well
    // would take a refund off the ledger twice.
    const calls = stubSessionList();
    expect(await parse(event('charge.refunded', charge()))).toEqual({
      ok: true,
      events: [],
    });
    expect(calls).toEqual([]);
  });

  it('maps an event type it does not handle to nothing', async () => {
    const calls = stubSessionList();
    expect(
      await parse(event('payment_intent.created', { id: INTENT_ID })),
    ).toEqual({ ok: true, events: [] });
    expect(calls).toEqual([]);
  });

  it.each([
    ['an amount', session({ amount_total: null })],
    ['a fractional amount', session({ amount_total: 12.5 })],
    ['a currency', session({ currency: undefined })],
    ['a session id', session({ id: 7 })],
  ])('fails on a mapped event with no usable %s', async (_, object) => {
    stubSessionList();
    await expect(
      parse(event('checkout.session.completed', object)),
    ).rejects.toThrow();
  });

  it('fails on a mapped event with no usable creation time', async () => {
    stubSessionList();
    const body = JSON.stringify({
      ...JSON.parse(event('checkout.session.completed', session())),
      created: 'yesterday',
    });
    await expect(parse(body)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- checkout

describe('starting a Stripe Checkout Session', () => {
  const request = {
    paymentId: 'pay-checkout-1',
    amountCents: 45075,
    returnUrl: 'https://residents.example/lot-records/payments/pay-checkout-1',
    cancelUrl: 'https://residents.example/lot-records/payments/pay-checkout-1',
  };

  function stubCreate(answer: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: urlOf(input), init: init ?? {} });
        return answer();
      }),
    );
    return calls;
  }

  const created = () =>
    Response.json({
      id: 'cs_test_created_1',
      object: 'checkout.session',
      url: 'https://checkout.stripe.com/c/pay/cs_test_created_1',
    });

  it('creates a one-hour, one-line USD payment session and answers its id and URL', async () => {
    const calls = stubCreate(created);

    expect(await adapter().createCheckout(request)).toEqual({
      providerPaymentRef: 'cs_test_created_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_created_1',
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(headers.get('stripe-version')).toBe('2026-10-28.endive');
    expect(headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    // A retried request can never open a second session for one payment.
    expect(headers.get('idempotency-key')).toBe('checkout:pay-checkout-1');

    expect(typeof init.body).toBe('string');
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '45075',
      'line_items[0][price_data][product_data][name]': 'Dues payment',
      'payment_method_types[0]': 'us_bank_account',
      'payment_method_types[1]': 'card',
      client_reference_id: 'pay-checkout-1',
      'metadata[payment_id]': 'pay-checkout-1',
      expires_at: String(NOW_S + 3600),
      success_url: request.returnUrl,
      cancel_url: request.cancelUrl,
    });
  });

  it('fails when Stripe refuses, so no payment row is written', async () => {
    stubCreate(() => new Response('{"error":{}}', { status: 402 }));
    await expect(adapter().createCheckout(request)).rejects.toThrow();
  });

  it('fails when Stripe answers without a session id or URL', async () => {
    stubCreate(() =>
      Response.json({ id: 'cs_test_1', object: 'checkout.session' }),
    );
    await expect(adapter().createCheckout(request)).rejects.toThrow();
  });
});
