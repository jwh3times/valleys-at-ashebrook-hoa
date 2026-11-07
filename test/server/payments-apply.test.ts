import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  applyPaymentEvent,
  InvalidPaymentEvent,
  UnhandledPaymentEvent,
} from '../../src/server/payments/apply';
import {
  fetchAdminLotDuesLedger,
  fetchMemberDuesLedger,
} from '../../src/server/lot-records/reads';
import { truncateAll, seedProperty, seedLotAuthority } from './fixtures';
import {
  fakeEvent,
  openExceptions,
  paymentRow,
  resetFakeEvents,
  seedPayment,
  storedEvents,
} from './payments-fixtures';

/**
 * The application path (ADR 0025, #539): a verified provider fact that a
 * payment succeeded credits the Lot's Dues Ledger EXACTLY ONCE, however many
 * times and by however many paths the fact arrives.
 *
 * Everything is observed the way the board and the homeowner observe it —
 * through the ledger reads and the stored payment rows — never by asking the
 * module what it decided internally.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const TODAY = '2026-11-06';

beforeEach(async () => {
  resetFakeEvents();
  await truncateAll();
  await seedProperty('lot-a');
  await seedProperty('lot-b');
  await seedLotAuthority('payer-1', 'lot-a', { startDay: '2020-01-01' });
});

const ledger = (lotId = 'lot-a') => fetchAdminLotDuesLedger(env, lotId);

describe('a confirmed payment', () => {
  it('credits the Lot as an online payment the board and the homeowner both see', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', amountCents: 45000 });

    await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1', { amountCents: 45000 }),
    );

    const board = await ledger();
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      kind: 'payment',
      amountCents: -45000,
      method: 'online',
      source: 'provider',
      paymentId: 'pay-1',
      recordedBy: null,
      description: 'Online payment',
      effectiveDay: '2026-11-02',
    });

    const [homeowner] = await fetchMemberDuesLedger(env, 'payer-1', TODAY);
    expect(homeowner.balanceCents).toBe(-45000);
    expect(homeowner.entries.map((e) => e.method)).toEqual(['online']);
    expect(await paymentRow('pay-1')).toEqual({
      status: 'succeeded',
      ledger_state: 'credited',
    });
    // The board's own entries carry an audit row naming who acted; a provider
    // credit has no actor, and its record is the stored event instead.
    const audit = await env.DATABASE.prepare(
      `SELECT COUNT(*) AS n FROM lot_record_events`,
    ).first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it('dates the credit by the Association Day the payment settled, not the UTC day', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    // 03:00 UTC on 3 November is still the evening of 2 November in Ashebrook.
    await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1', {
        occurredAt: new Date('2026-11-03T03:00:00Z'),
      }),
    );

    expect((await ledger())[0]?.effectiveDay).toBe('2026-11-02');
  });
});

describe('the payment status a homeowner and the board read', () => {
  it('shows an ACH payment as pending, with nothing on the ledger until it settles', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    await applyPaymentEvent(env, fakeEvent('payment_pending', 'ref_pay-1'));

    expect(await paymentRow('pay-1')).toEqual({
      status: 'pending',
      ledger_state: 'none',
    });
    expect(await ledger()).toEqual([]);
  });

  it('ignores a pending fact that arrives after the payment already settled', async () => {
    // ACH events can arrive out of order; a terminal state is never
    // overwritten by an earlier-stage event.
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_pay-1'));

    const late = await applyPaymentEvent(
      env,
      fakeEvent('payment_pending', 'ref_pay-1'),
    );

    expect(late).toMatchObject({ kind: 'recorded', ledgerEntryId: null });
    expect(await paymentRow('pay-1')).toEqual({
      status: 'succeeded',
      ledger_state: 'credited',
    });
    expect(await ledger()).toHaveLength(1);
    expect(await storedEvents()).toHaveLength(2);
  });

  it('records a failed or abandoned payment with no ledger effect', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await seedPayment({ id: 'pay-2', lotId: 'lot-a' });

    await applyPaymentEvent(env, fakeEvent('payment_pending', 'ref_pay-1'));
    await applyPaymentEvent(env, fakeEvent('payment_failed', 'ref_pay-1'));
    await applyPaymentEvent(env, fakeEvent('payment_canceled', 'ref_pay-2'));

    expect((await paymentRow('pay-1'))?.status).toBe('failed');
    expect((await paymentRow('pay-2'))?.status).toBe('canceled');
    expect(await ledger()).toEqual([]);
  });

  it('keeps a failed payment failed when a stale pending fact arrives afterwards', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await applyPaymentEvent(env, fakeEvent('payment_failed', 'ref_pay-1'));
    await applyPaymentEvent(env, fakeEvent('payment_pending', 'ref_pay-1'));

    expect((await paymentRow('pay-1'))?.status).toBe('failed');
  });

  it('credits a payment the provider confirms after first reporting it failed, since the money moved', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await applyPaymentEvent(env, fakeEvent('payment_failed', 'ref_pay-1'));
    await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_pay-1'));

    expect(await paymentRow('pay-1')).toEqual({
      status: 'succeeded',
      ledger_state: 'credited',
    });
    expect(await ledger()).toHaveLength(1);
  });
});

describe('a fact the automatic path will not guess about', () => {
  it('credits the amount the provider confirms when it differs, and flags it for the board', async () => {
    // Money that actually moved is still recorded — at what moved.
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', amountCents: 45000 });

    const result = await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1', { amountCents: 40000 }),
    );

    expect(result).toMatchObject({ kind: 'recorded', outcome: 'exception' });
    expect((await ledger()).map((e) => e.amountCents)).toEqual([-40000]);
    expect(await openExceptions()).toEqual([
      {
        reason: 'amount_mismatch',
        payment_id: 'pay-1',
        provider_event_id: 'evt_1',
      },
    ]);
  });

  it('does not credit money in another currency, and flags it', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1', { currency: 'CAD' }),
    );

    expect(await ledger()).toEqual([]);
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('none');
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'currency_mismatch',
    ]);
  });

  it('stores a payment the site never started as unmatched, crediting no Lot, and flags it', async () => {
    // A payment taken in the provider's own dashboard: real money, but no
    // `payments` row says which Lot it was for.
    const result = await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_unknown'),
    );

    expect(result).toEqual({
      kind: 'recorded',
      outcome: 'unmatched',
      ledgerEntryId: null,
    });
    expect(await ledger('lot-a')).toEqual([]);
    expect(await ledger('lot-b')).toEqual([]);
    expect(await storedEvents()).toMatchObject([
      { payment_id: null, outcome: 'unmatched', ledger_entry_id: null },
    ]);
    expect(await openExceptions()).toEqual([
      {
        reason: 'unmatched_payment',
        payment_id: null,
        provider_event_id: 'evt_1',
      },
    ]);
  });

  it('stores an unmatched fact that moved no money without troubling the board', async () => {
    await applyPaymentEvent(env, fakeEvent('payment_pending', 'ref_unknown'));

    expect(await storedEvents()).toMatchObject([{ outcome: 'unmatched' }]);
    expect(await openExceptions()).toEqual([]);
  });

  it('records a fact with a blank payment reference as carrying no reference', async () => {
    // A blank reference names nothing, so it must never be able to match a
    // payment row, and no payment row may hold one for it to match.
    await expect(
      seedPayment({ id: 'pay-1', lotId: 'lot-a', ref: '  ' }),
    ).rejects.toThrow();

    await applyPaymentEvent(env, fakeEvent('payment_succeeded', '  '));

    expect(await storedEvents()).toMatchObject([
      { payment_id: null, outcome: 'unmatched' },
    ]);
    const stored = await env.DATABASE.prepare(
      `SELECT provider_payment_ref AS ref FROM payment_events`,
    ).first<{ ref: string | null }>();
    expect(stored?.ref).toBeNull();
  });

  it('never matches a payment that belongs to another provider', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', provider: 'other' });

    await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_pay-1'));

    expect(await ledger()).toEqual([]);
    expect(await storedEvents()).toMatchObject([{ outcome: 'unmatched' }]);
  });
});

describe('what can and cannot stop a fact being recorded', () => {
  it('records a settlement with every site flag off, because the ledger outlives the flags', async () => {
    // A homeowner whose ACH debit was initiated yesterday settles next week,
    // whether or not the site is still taking payments (ADR 0025).
    await env.DATABASE.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, 0)`,
    )
      .bind(
        JSON.stringify({
          officialMode: false,
          lotRecordsEnabled: false,
          onlinePaymentsEnabled: false,
        }),
      )
      .run();
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_pay-1'));

    expect(await ledger()).toHaveLength(1);
  });

  it('writes nothing at all when any part of the batch fails', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', amountCents: 45000 });
    const original = env.DATABASE.batch.bind(env.DATABASE);
    const spy = vi
      .spyOn(env.DATABASE, 'batch')
      .mockImplementation((statements) =>
        original([
          ...statements,
          // A statement that cannot succeed, after all the real ones.
          env.DATABASE.prepare('INSERT INTO payments (id) VALUES (NULL)'),
        ]),
      );
    try {
      await expect(
        applyPaymentEvent(
          env,
          fakeEvent('payment_succeeded', 'ref_pay-1', { amountCents: 1 }),
        ),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(await ledger()).toEqual([]);
    expect(await storedEvents()).toEqual([]);
    expect(await openExceptions()).toEqual([]);
    expect(await paymentRow('pay-1')).toEqual({
      status: 'created',
      ledger_state: 'none',
    });
  });

  it('credits once when two reports of one settlement race each other', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    const results = await Promise.all([
      applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_pay-1')),
      applyPaymentEvent(
        env,
        fakeEvent('payment_succeeded', 'ref_pay-1', { via: 'reconciliation' }),
      ),
    ]);

    expect(
      results.map((r) => (r.kind === 'recorded' ? r.outcome : r.kind)),
    ).toEqual(expect.arrayContaining(['applied', 'duplicate_effect']));
    expect(await ledger()).toHaveLength(1);
    expect(await storedEvents()).toHaveLength(2);
  });

  it.each([
    ['a negative amount', { amountCents: -100 }],
    ['a fractional amount', { amountCents: 10.5 }],
    ['an amount past the ledger cap', { amountCents: 100_000_001 }],
    ['a malformed currency', { currency: 'us dollars' }],
    ['a blank event id', { providerEventId: '  ' }],
    ['an unknown event type', { type: 'payment_refunded' as never }],
    ['an unknown arrival path', { via: 'email' as never }],
    ['an invalid time', { occurredAt: new Date('not a date') }],
  ])('refuses %s, storing nothing', async (_label, overrides) => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    await expect(
      applyPaymentEvent(
        env,
        fakeEvent('payment_succeeded', 'ref_pay-1', overrides),
      ),
    ).rejects.toThrow(InvalidPaymentEvent);

    expect(await storedEvents()).toEqual([]);
    expect(await ledger()).toEqual([]);
  });
});

describe('the same fact arriving more than once', () => {
  it('stores a redelivered event once and credits once', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    const event = fakeEvent('payment_succeeded', 'ref_pay-1');

    expect(await applyPaymentEvent(env, event)).toMatchObject({
      kind: 'recorded',
      outcome: 'applied',
    });
    expect(await applyPaymentEvent(env, event)).toEqual({
      kind: 'duplicate_event',
    });

    expect(await ledger()).toHaveLength(1);
    expect(await storedEvents()).toHaveLength(1);
  });

  it('records a second fact for the same settlement as a duplicate effect, crediting nothing more', async () => {
    // A webhook and the reconciliation pull describe one settlement under two
    // ids. Event-id uniqueness alone would credit it twice.
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1'),
      new Date('2026-11-02T16:00:00Z'),
    );

    const pulled = await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1', { via: 'reconciliation' }),
      new Date('2026-11-03T07:00:00Z'),
    );

    expect(pulled).toEqual({
      kind: 'recorded',
      outcome: 'duplicate_effect',
      ledgerEntryId: null,
    });
    expect(await ledger()).toHaveLength(1);
    expect((await storedEvents()).map((e) => [e.via, e.outcome])).toEqual([
      ['webhook', 'applied'],
      ['reconciliation', 'duplicate_effect'],
    ]);
  });

  it('puts one mismatch in front of the board, however many paths report it', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    const euros = { currency: 'eur' };
    await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1', euros),
    );

    const pulled = await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1', {
        ...euros,
        via: 'reconciliation',
      }),
    );

    expect(pulled).toMatchObject({ outcome: 'duplicate_effect' });
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'currency_mismatch',
    ]);
  });

  it('puts one unmatched payment in front of the board, however many paths report it', async () => {
    await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_unknown'));
    await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_unknown', { via: 'reconciliation' }),
    );

    expect(await storedEvents()).toHaveLength(2);
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'unmatched_payment',
    ]);
  });
});

describe('a fact this path does not handle yet', () => {
  // Withdrawals, reinstatements and disputes arrive with #540. Until then such
  // a fact is refused, not stored: stored under its event id, it would be a
  // `duplicate_event` when redelivered after #540 ships, and lost.
  it.each(['funds_withdrawn', 'funds_reinstated', 'dispute_opened'] as const)(
    'refuses %s, storing nothing and leaving the credit alone',
    async (type) => {
      await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
      await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_pay-1'));

      await expect(
        applyPaymentEvent(env, fakeEvent(type, 'ref_pay-1')),
      ).rejects.toThrow(UnhandledPaymentEvent);

      expect(await storedEvents()).toHaveLength(1);
      expect(await ledger()).toHaveLength(1);
      expect(await openExceptions()).toEqual([]);
      expect((await paymentRow('pay-1'))?.ledger_state).toBe('credited');
    },
  );
});
