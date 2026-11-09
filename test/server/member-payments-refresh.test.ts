import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { POST } from '../../src/pages/api/member/payments/refresh';
import { setPaymentProviderForTests } from '../../src/server/payments/registry';
import type { AuthContext } from '../../src/server/authz/guards';
import type { NormalizedPaymentEvent } from '../../src/server/payments/provider';
import { truncateAll, seedProperty, seedLotAuthority } from './fixtures';
import {
  fakeEvent,
  fakeProvider,
  paymentRow,
  resetFakeEvents,
  seedPayment,
  unconfigurePayments,
} from './payments-fixtures';

/**
 * `POST /api/member/payments/refresh` (ADR 0025, #544): a homeowner who
 * believes they paid asks the site to check one payment with the provider.
 *
 * Observed as the homeowner sees it — the status and the payment's state in
 * the answer — and as the board does: the payment row and the ledger entry
 * afterwards, and how often the provider was asked.
 */

const ORIGIN = 'http://localhost';

const caller = (personId: string | null = 'payer-1'): AuthContext => ({
  userId: `account-${personId ?? 'unlinked'}`,
  personId,
  capabilities: new Set(['member']),
  lotIds: ['lot-a'],
  contentTier: 'homeowner',
  hasCurrentBoardTerm: false,
});

async function setSite(flags: Record<string, unknown>) {
  await env.DATABASE.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(flags), Date.now())
    .run();
}

function refresh(
  body: unknown,
  {
    as = caller(),
    origin = ORIGIN,
    contentType = 'application/json',
  }: {
    as?: AuthContext | null;
    origin?: string | null;
    contentType?: string;
  } = {},
) {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (origin !== null) headers.origin = origin;
  return POST({
    request: new Request(`${ORIGIN}/api/member/payments/refresh`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { authContext: as },
  } as never);
}

let fake: ReturnType<typeof fakeProvider>;
const useFake = (options: Parameters<typeof fakeProvider>[0] = {}) => {
  fake = fakeProvider(options);
  setPaymentProviderForTests(fake);
};

const settled = (ref: string): NormalizedPaymentEvent =>
  fakeEvent('payment_succeeded', ref, {
    providerEventId: `reconciliation:${ref}:payment_succeeded`,
    via: 'reconciliation',
  });

async function ledgerEntries() {
  const { results } = await env.DATABASE.prepare(
    'SELECT lot_id, kind, amount_cents, payment_id FROM dues_ledger_entries',
  ).all<{
    lot_id: string;
    kind: string;
    amount_cents: number;
    payment_id: string | null;
  }>();
  return results;
}

/** An ISO time `ms` before now: the route reads the real clock. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MINUTE = 60 * 1000;

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
  await seedProperty('lot-b');
  await seedLotAuthority('payer-1', 'lot-a', { startDay: '2020-01-01' });
  await seedLotAuthority('neighbor-1', 'lot-b', { startDay: '2020-01-01' });
  // Online payments OFF: chasing a payment already made needs only the two
  // Lot Records flags.
  await setSite({ officialMode: true, lotRecordsEnabled: true });
  useFake();
});

afterEach(() => {
  setPaymentProviderForTests(null);
});

describe('checking a payment with the provider', () => {
  it('records what the provider reports and answers the new status', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });
    useFake({ pulls: { 'ref_pay-1': [settled('ref_pay-1')] } });

    const res = await refresh({ paymentId: 'pay-1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'succeeded',
      ledgerState: 'credited',
      pulled: true,
    });
    expect(fake.pulledRefs).toEqual(['ref_pay-1']);
    expect(await ledgerEntries()).toEqual([
      {
        lot_id: 'lot-a',
        kind: 'payment',
        amount_cents: -45000,
        payment_id: 'pay-1',
      },
    ]);
  });

  it('answers the stored status when the provider has nothing new', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });

    const res = await refresh({ paymentId: 'pay-1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'pending',
      ledgerState: 'none',
      pulled: true,
    });
    expect(await paymentRow('pay-1')).toEqual({
      status: 'pending',
      ledger_state: 'none',
    });
  });

  it('answers 502 and changes nothing when the provider cannot be reached', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });
    useFake({ pulls: { 'ref_pay-1': new Error('provider down') } });

    const res = await refresh({ paymentId: 'pay-1' });

    expect(res.status).toBe(502);
    expect(await paymentRow('pay-1')).toEqual({
      status: 'pending',
      ledger_state: 'none',
    });
    expect(await ledgerEntries()).toEqual([]);
  });
});

describe('asking the provider at most once a minute per payment', () => {
  it('does not ask again within a minute, and still answers the stored status', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: ago(5 * MINUTE),
    });

    const first = await refresh({ paymentId: 'pay-1' });
    const second = await refresh({ paymentId: 'pay-1' });

    expect(await first.json()).toMatchObject({ pulled: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      status: 'pending',
      ledgerState: 'none',
      pulled: false,
    });
    expect(fake.pulledRefs).toEqual(['ref_pay-1']);
  });

  it.each(['succeeded', 'failed', 'canceled'])(
    'does not ask about a payment that is already %s',
    async (status) => {
      await seedPayment({ id: 'pay-1', lotId: 'lot-a', status });

      const res = await refresh({ paymentId: 'pay-1' });

      expect(await res.json()).toEqual({
        status,
        ledgerState: 'none',
        pulled: false,
      });
      expect(fake.pulledRefs).toEqual([]);
    },
  );

  it('does not ask this provider about a payment made through another one', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      provider: 'previous-provider',
    });

    const res = await refresh({ paymentId: 'pay-1' });

    expect(await res.json()).toEqual({
      status: 'pending',
      ledgerState: 'none',
      pulled: false,
    });
    expect(fake.pulledRefs).toEqual([]);
  });

  it('does not ask about a payment started less than a minute ago', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      createdAt: ago(20 * 1000),
    });

    const res = await refresh({ paymentId: 'pay-1' });

    expect(await res.json()).toEqual({
      status: 'created',
      ledgerState: 'none',
      pulled: false,
    });
    expect(fake.pulledRefs).toEqual([]);
  });

  it('asks only once when two refreshes arrive together', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: ago(5 * MINUTE),
    });

    const answers = await Promise.all([
      refresh({ paymentId: 'pay-1' }),
      refresh({ paymentId: 'pay-1' }),
    ]);

    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    expect(fake.pulledRefs).toEqual(['ref_pay-1']);
  });
});

describe('whose payments a homeowner may check', () => {
  it('lets a co-owner check a payment a fellow co-owner started', async () => {
    await seedLotAuthority('coowner-1', 'lot-a', { startDay: '2020-01-01' });
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });

    const res = await refresh(
      { paymentId: 'pay-1' },
      { as: caller('coowner-1') },
    );

    expect(res.status).toBe(200);
    expect(fake.pulledRefs).toEqual(['ref_pay-1']);
  });

  it('answers 404 to a buyer asking about the seller’s payment, and asks nothing', async () => {
    await env.DATABASE.prepare(
      "UPDATE ownerships SET end_day = '2026-11-05' WHERE owner_party_id = 'payer-1'",
    ).run();
    await seedLotAuthority('buyer-1', 'lot-a', { startDay: '2026-11-06' });
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-11-01T12:00:00Z',
    });

    const res = await refresh(
      { paymentId: 'pay-1' },
      { as: caller('buyer-1') },
    );

    expect(res.status).toBe(404);
    expect(fake.pulledRefs).toEqual([]);
  });

  it('answers 404 for another Lot’s payment and for a payment that does not exist', async () => {
    await seedPayment({
      id: 'pay-b',
      lotId: 'lot-b',
      personId: 'neighbor-1',
      status: 'pending',
    });

    expect((await refresh({ paymentId: 'pay-b' })).status).toBe(404);
    expect((await refresh({ paymentId: 'no-such-payment' })).status).toBe(404);
    expect(fake.pulledRefs).toEqual([]);
  });

  it('answers 404 to a member with no Person Link to scope them by', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });

    const res = await refresh({ paymentId: 'pay-1' }, { as: caller(null) });

    expect(res.status).toBe(404);
    expect(fake.pulledRefs).toEqual([]);
  });

  it('answers 400 to a missing payment id, and to a body that is not JSON', async () => {
    expect((await refresh({})).status).toBe(400);
    expect((await refresh('not json')).status).toBe(400);
  });
});

describe('the gate, in its fixed order', () => {
  beforeEach(async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });
  });

  it('answers 404 with either Lot Records flag off', async () => {
    await setSite({ officialMode: true, lotRecordsEnabled: false });
    expect((await refresh({ paymentId: 'pay-1' })).status).toBe(404);
    await setSite({ officialMode: false, lotRecordsEnabled: true });
    expect((await refresh({ paymentId: 'pay-1' })).status).toBe(404);
    expect(fake.pulledRefs).toEqual([]);
  });

  it('answers 404 when no payment provider is configured', async () => {
    setPaymentProviderForTests(null);
    expect((await refresh({ paymentId: 'pay-1' })).status).toBe(404);
  });

  it('answers 503 during the write freeze, before the header checks', async () => {
    await env.DATABASE.prepare(
      "INSERT INTO cutover_settings (key, value, updated_at) VALUES ('write_freeze', 'on', 1)",
    ).run();
    const res = await refresh(
      { paymentId: 'pay-1' },
      { origin: 'https://elsewhere.example' },
    );
    expect(res.status).toBe(503);
    expect(fake.pulledRefs).toEqual([]);
  });

  it('answers 403 to another origin, and to none', async () => {
    expect(
      (
        await refresh(
          { paymentId: 'pay-1' },
          { origin: 'https://elsewhere.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await refresh({ paymentId: 'pay-1' }, { origin: null })).status,
    ).toBe(403);
  });

  it('answers 415 to a form post, before reading the session', async () => {
    const res = await refresh('paymentId=pay-1', {
      as: null,
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(415);
  });

  it('answers 401 to an anonymous caller, and 403 to one without Lot Authority', async () => {
    expect((await refresh({ paymentId: 'pay-1' }, { as: null })).status).toBe(
      401,
    );
    const visitor: AuthContext = {
      ...caller(),
      capabilities: new Set(),
      lotIds: [],
    };
    expect(
      (await refresh({ paymentId: 'pay-1' }, { as: visitor })).status,
    ).toBe(403);
    expect(fake.pulledRefs).toEqual([]);
  });
});
