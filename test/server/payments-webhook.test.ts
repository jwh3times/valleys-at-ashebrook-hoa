import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { POST } from '../../src/pages/api/webhooks/payments';
import { setPaymentProviderForTests } from '../../src/server/payments/registry';
import { fetchAdminLotDuesLedger } from '../../src/server/lot-records/reads';
import type { NormalizedPaymentEvent } from '../../src/server/payments/provider';
import { truncateAll, seedProperty, seedLotAuthority } from './fixtures';
import {
  fakeEvent,
  fakeProvider,
  openExceptions,
  paymentRow,
  resetFakeEvents,
  seedPayment,
  storedEvents,
  stripeSignature,
  configurePayments,
  unconfigurePayments,
  PAYMENT_SECRETS,
} from './payments-fixtures';

/**
 * `POST /api/webhooks/payments` (ADR 0025, #541): a verified provider delivery
 * is recorded through the application path, and nothing else is.
 *
 * Observed as the provider and the board observe it: the status the provider
 * gets back (which decides whether it retries) and the rows that exist
 * afterwards. The payment secrets are cleared before every test, so the bare
 * pool `env` — which a bootstrapped `.dev.vars` may fill — never decides one
 * (#524).
 */

const WEBHOOK_URL = 'http://localhost/api/webhooks/payments';

const deliver = (
  body = '{"id":"evt_any"}',
  headers: Record<string, string> = {},
) =>
  POST({
    request: new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  } as never);

const useFake = (queued: Parameters<typeof fakeProvider>[0] = {}) => {
  const fake = fakeProvider(queued);
  setPaymentProviderForTests(fake);
  return fake;
};

const ledger = () => fetchAdminLotDuesLedger(env, 'lot-a');

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  unconfigurePayments();
  resetFakeEvents();
  await truncateAll();
  await env.DATABASE.prepare(
    "DELETE FROM cutover_settings WHERE key = 'write_freeze'",
  ).run();
  await seedProperty('lot-a');
  await seedLotAuthority('payer-1', 'lot-a', { startDay: '2020-01-01' });
  await seedPayment({ id: 'pay-1', lotId: 'lot-a', amountCents: 45000 });
});

afterEach(() => {
  setPaymentProviderForTests(null);
  unconfigurePayments();
});

describe('a provider delivery', () => {
  it('credits the Lot once for a verified settlement, and answers 200', async () => {
    useFake({ events: [fakeEvent('payment_succeeded', 'ref_pay-1')] });

    expect((await deliver()).status).toBe(200);

    const entries = await ledger();
    expect(entries.map((e) => [e.kind, e.amountCents])).toEqual([
      ['payment', -45000],
    ]);
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('credited');
  });

  it('answers 200 to a redelivery and credits nothing more', async () => {
    const settled = fakeEvent('payment_succeeded', 'ref_pay-1');
    useFake({ events: [settled] });

    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);

    expect(await ledger()).toHaveLength(1);
    expect(await storedEvents()).toHaveLength(1);
  });

  it('answers 200 to a fact for a payment the site never started, and stores it unmatched', async () => {
    useFake({ events: [fakeEvent('payment_succeeded', 'ref_unknown')] });

    expect((await deliver()).status).toBe(200);

    expect(await ledger()).toEqual([]);
    expect((await storedEvents()).map((e) => e.outcome)).toEqual(['unmatched']);
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'unmatched_payment',
    ]);
  });

  it('answers 200 and records nothing for an event type the adapter does not map', async () => {
    useFake({ events: [] });

    expect((await deliver()).status).toBe(200);

    expect(await storedEvents()).toEqual([]);
  });

  it('applies each fact of one delivery, in order', async () => {
    useFake({
      events: [
        fakeEvent('payment_pending', 'ref_pay-1'),
        fakeEvent('payment_succeeded', 'ref_pay-1'),
      ],
    });

    expect((await deliver()).status).toBe(200);

    expect((await storedEvents()).map((e) => e.type)).toEqual([
      'payment_pending',
      'payment_succeeded',
    ]);
    expect(await ledger()).toHaveLength(1);
  });

  it('hands the adapter the raw body, byte for byte', async () => {
    const fake = useFake();
    const body = '{ "id": "evt_spacing",\n  "kept": "as sent" }';

    await deliver(body);

    expect(fake.webhookBodies).toEqual([body]);
  });

  it('records a payment while every site flag is off, since ingestion never reads one', async () => {
    // truncateAll leaves no site settings row, so every gate is at its
    // default: off. A payment already in flight must still land.
    useFake({ events: [fakeEvent('payment_succeeded', 'ref_pay-1')] });

    expect((await deliver()).status).toBe(200);

    expect(await ledger()).toHaveLength(1);
  });
});

describe('a delivery that must record nothing', () => {
  it('answers 404 when no provider is configured', async () => {
    expect((await deliver()).status).toBe(404);
    expect(await storedEvents()).toEqual([]);
  });

  it('answers 400 to a delivery the adapter cannot verify, and stores nothing', async () => {
    const fake = useFake({
      verified: false,
      events: [fakeEvent('payment_succeeded', 'ref_pay-1')],
    });

    expect((await deliver()).status).toBe(400);

    expect(fake.webhookBodies).toHaveLength(1);
    expect(await storedEvents()).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it('answers 503 during the write freeze, before reading the delivery', async () => {
    const fake = useFake({
      events: [fakeEvent('payment_succeeded', 'ref_pay-1')],
    });
    await env.DATABASE.prepare(
      "INSERT INTO cutover_settings (key, value, updated_at) VALUES ('write_freeze', 'on', 1)",
    ).run();

    expect((await deliver()).status).toBe(503);

    expect(fake.webhookBodies).toEqual([]);
    expect(await storedEvents()).toEqual([]);
  });

  it('answers 500, so the provider retries, when a verified delivery cannot be read', async () => {
    useFake({ parseError: new Error('lookup failed') });

    expect((await deliver()).status).toBe(500);

    expect(await storedEvents()).toEqual([]);
  });

  it('answers 500 when a fact cannot be applied, keeping the facts before it', async () => {
    const impossible: NormalizedPaymentEvent = fakeEvent(
      'payment_succeeded',
      'ref_pay-1',
      { amountCents: -1 },
    );
    useFake({
      events: [fakeEvent('payment_pending', 'ref_pay-1'), impossible],
    });

    expect((await deliver()).status).toBe(500);

    // Each fact is its own batch: the first is recorded, the impossible one
    // is not, and a redelivery re-applies both (the first as a duplicate).
    expect((await storedEvents()).map((e) => e.type)).toEqual([
      'payment_pending',
    ]);
    expect(await ledger()).toEqual([]);
  });
});

describe('a delivery signed by Stripe, end to end', () => {
  const SECRET = PAYMENT_SECRETS.PAYMENTS_WEBHOOK_SECRET;

  const completed = JSON.stringify({
    id: 'evt_route_1',
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.parse('2026-11-02T15:00:00Z') / 1000),
    data: {
      object: {
        id: 'cs_test_route_1',
        object: 'checkout.session',
        amount_total: 45000,
        currency: 'usd',
        payment_intent: 'pi_test_route_1',
        payment_status: 'paid',
      },
    },
  });

  beforeEach(async () => {
    await truncateAll();
    await seedProperty('lot-a');
    await seedLotAuthority('payer-1', 'lot-a', { startDay: '2020-01-01' });
    await seedPayment({
      id: 'pay-s',
      lotId: 'lot-a',
      amountCents: 45000,
      provider: 'stripe',
      ref: 'cs_test_route_1',
    });
  });

  it('credits the Lot from a correctly signed checkout completion', async () => {
    configurePayments();
    const { header } = await stripeSignature(SECRET, completed);

    expect(
      (await deliver(completed, { 'stripe-signature': header })).status,
    ).toBe(200);

    expect((await ledger()).map((e) => e.amountCents)).toEqual([-45000]);
    expect((await storedEvents()).map((e) => e.provider_event_id)).toEqual([
      'evt_route_1',
    ]);
  });

  it('answers 400 to an unsigned delivery and stores nothing', async () => {
    configurePayments();

    expect((await deliver(completed)).status).toBe(400);

    expect(await storedEvents()).toEqual([]);
  });

  it('answers 400 to a delivery signed with another secret', async () => {
    configurePayments();
    const { header } = await stripeSignature('whsec_forged', completed);

    expect(
      (await deliver(completed, { 'stripe-signature': header })).status,
    ).toBe(400);

    expect(await storedEvents()).toEqual([]);
  });

  it('answers 404 with the provider named but no webhook secret', async () => {
    configurePayments({ PAYMENTS_WEBHOOK_SECRET: '' });
    const { header } = await stripeSignature(SECRET, completed);

    expect(
      (await deliver(completed, { 'stripe-signature': header })).status,
    ).toBe(404);

    expect(await storedEvents()).toEqual([]);
  });
});
