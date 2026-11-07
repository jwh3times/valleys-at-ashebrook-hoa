import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  applyPaymentEvent,
  InvalidPaymentEvent,
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

/** The provider's clock for a withdrawal cycle: each fact a day after the last. */
const day = (n: number) => new Date(Date.UTC(2026, 10, 2 + n, 15));

/** Credit pay-1 on lot-a, as a settled checkout leaves it. */
async function settled(amountCents = 45000) {
  await seedPayment({ id: 'pay-1', lotId: 'lot-a', amountCents });
  await applyPaymentEvent(
    env,
    fakeEvent('payment_succeeded', 'ref_pay-1', {
      amountCents,
      occurredAt: day(0),
    }),
  );
}

describe('money that leaves after it was credited', () => {
  it('reverses exactly the credit, keeps both entries visible, and flags it for the board', async () => {
    await settled();

    const result = await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );

    const entries = await ledger();
    expect(entries).toMatchObject([
      { kind: 'payment', amountCents: -45000, source: 'provider' },
      {
        kind: 'reversal',
        amountCents: 45000,
        source: 'provider',
        paymentId: 'pay-1',
        reversesEntryId: entries[0]?.id,
        recordedBy: null,
        effectiveDay: '2026-11-05',
        operationKey: `provider:pay-1:withdraw:${entries[0]?.id}`,
      },
    ]);
    expect(result).toMatchObject({
      kind: 'recorded',
      ledgerEntryId: entries[1]?.id,
    });
    expect(await paymentRow('pay-1')).toEqual({
      status: 'succeeded',
      ledger_state: 'withdrawn',
    });
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'funds_withdrawn',
    ]);
    const [homeowner] = await fetchMemberDuesLedger(env, 'payer-1', TODAY);
    expect(homeowner.balanceCents).toBe(0);
  });

  it('writes no entry for a withdrawal of less than the credit, and asks the board to record it', async () => {
    // A reversal must be an exact negation, so a partial refund cannot be
    // one; the board records the matching adjustment itself.
    await settled();

    const result = await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        amountCents: 10000,
        occurredAt: day(3),
      }),
    );

    expect(result).toMatchObject({ outcome: 'exception', ledgerEntryId: null });
    expect((await ledger()).map((e) => e.kind)).toEqual(['payment']);
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('credited');
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'partial_withdrawal',
    ]);
  });

  it('writes no entry for a withdrawal when nothing was credited, and flags it', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await applyPaymentEvent(env, fakeEvent('payment_pending', 'ref_pay-1'));

    const result = await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1'),
    );

    expect(result).toMatchObject({ outcome: 'exception', ledgerEntryId: null });
    expect(await ledger()).toEqual([]);
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('none');
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'withdrawal_without_credit',
    ]);
  });

  it('takes the whole credit away when more than it is withdrawn', async () => {
    await settled();

    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        amountCents: 46500,
        occurredAt: day(3),
      }),
    );

    expect((await ledger()).map((e) => e.amountCents)).toEqual([-45000, 45000]);
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'funds_withdrawn',
    ]);
  });

  it('reverses once when a webhook and a pull both report the withdrawal', async () => {
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );

    const pulled = await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        occurredAt: day(3),
        via: 'reconciliation',
      }),
    );

    expect(pulled).toEqual({
      kind: 'recorded',
      outcome: 'duplicate_effect',
      ledgerEntryId: null,
    });
    expect((await ledger()).map((e) => e.kind)).toEqual([
      'payment',
      'reversal',
    ]);
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'funds_withdrawn',
    ]);
  });
});

/** The resolutions the board's queue will show, with who decided each. */
async function resolutions() {
  const { results } = await env.DATABASE.prepare(
    `SELECT x.reason, r.resolution, r.acting_account_id
       FROM payment_exception_resolutions r
       JOIN payment_exceptions x ON x.id = r.exception_id
      ORDER BY r.resolved_at, r.id`,
  ).all<{
    reason: string;
    resolution: string;
    acting_account_id: string | null;
  }>();
  return results;
}

describe('money that comes back after a withdrawal', () => {
  it('credits the Lot again as a new entry and closes the withdrawal it answers', async () => {
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );

    const result = await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', { occurredAt: day(20) }),
    );

    const entries = await ledger();
    expect(entries).toMatchObject([
      { kind: 'payment', amountCents: -45000 },
      { kind: 'reversal', amountCents: 45000 },
      {
        kind: 'payment',
        amountCents: -45000,
        method: 'online',
        source: 'provider',
        paymentId: 'pay-1',
        reversesEntryId: null,
        recordedBy: null,
        effectiveDay: '2026-11-22',
        operationKey: `provider:pay-1:reinstate:${entries[1]?.id}`,
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'applied',
      ledgerEntryId: entries[2]?.id,
    });
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('credited');
    expect(await openExceptions()).toEqual([]);
    expect(await resolutions()).toEqual([
      {
        reason: 'funds_withdrawn',
        resolution: 'funds_reinstated',
        acting_account_id: null,
      },
    ]);
    const [homeowner] = await fetchMemberDuesLedger(env, 'payer-1', TODAY);
    expect(homeowner.balanceCents).toBe(-45000);
  });

  it('reinstates once when a webhook and a pull both report it', async () => {
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );
    await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', { occurredAt: day(20) }),
    );

    const pulled = await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', {
        occurredAt: day(20),
        via: 'reconciliation',
      }),
    );

    expect(pulled).toMatchObject({ outcome: 'duplicate_effect' });
    expect((await ledger()).map((e) => e.amountCents)).toEqual([
      -45000, 45000, -45000,
    ]);
  });

  it('reinstates once when two reports of it race each other', async () => {
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );

    await Promise.all([
      applyPaymentEvent(
        env,
        fakeEvent('funds_reinstated', 'ref_pay-1', { occurredAt: day(20) }),
      ),
      applyPaymentEvent(
        env,
        fakeEvent('funds_reinstated', 'ref_pay-1', {
          occurredAt: day(20),
          via: 'reconciliation',
        }),
      ),
    ]);

    expect((await ledger()).map((e) => e.kind)).toEqual([
      'payment',
      'reversal',
      'payment',
    ]);
    expect(await resolutions()).toHaveLength(1);
  });

  it('leaves a withdrawal the board already resolved as the board resolved it', async () => {
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );
    await env.DATABASE.prepare(
      `INSERT INTO payment_exception_resolutions
         (id, exception_id, resolution, note, acting_account_id, resolved_at)
       SELECT 'by-board', id, 'reviewed_no_action', NULL, 'board-1', 1
         FROM payment_exceptions`,
    ).run();

    await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', { occurredAt: day(20) }),
    );

    expect((await ledger()).map((e) => e.kind)).toEqual([
      'payment',
      'reversal',
      'payment',
    ]);
    expect(await resolutions()).toEqual([
      {
        reason: 'funds_withdrawn',
        resolution: 'reviewed_no_action',
        acting_account_id: 'board-1',
      },
    ]);
  });

  it('follows a second withdrawal and reinstatement of the same payment', async () => {
    await settled();
    const cycle = [
      ['funds_withdrawn', 3],
      ['funds_reinstated', 20],
      ['funds_withdrawn', 30],
      ['funds_reinstated', 50],
    ] as const;
    for (const [type, n] of cycle)
      await applyPaymentEvent(
        env,
        fakeEvent(type, 'ref_pay-1', { occurredAt: day(n) }),
      );

    const entries = await ledger();
    expect(entries.map((e) => [e.kind, e.amountCents])).toEqual([
      ['payment', -45000],
      ['reversal', 45000],
      ['payment', -45000],
      ['reversal', 45000],
      ['payment', -45000],
    ]);
    // The second withdrawal reverses the reinstatement, not the settlement.
    expect(entries[3]?.reversesEntryId).toBe(entries[2]?.id);
    expect(entries[4]?.operationKey).toBe(
      `provider:pay-1:reinstate:${entries[3]?.id}`,
    );
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('credited');
    expect(await openExceptions()).toEqual([]);
    expect((await resolutions()).map((r) => r.resolution)).toEqual([
      'funds_reinstated',
      'funds_reinstated',
    ]);
  });

  it('recognizes a late report of an earlier cycle under a new id, changing nothing', async () => {
    // A pull may describe the first withdrawal and reinstatement long after
    // the webhook delivered them; they must not be taken as the next cycle.
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );
    await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', { occurredAt: day(20) }),
    );

    const lateWithdrawal = await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        occurredAt: day(3),
        via: 'reconciliation',
      }),
    );
    expect(lateWithdrawal).toMatchObject({ outcome: 'duplicate_effect' });

    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(30) }),
    );
    const lateReinstatement = await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', {
        occurredAt: day(20),
        via: 'reconciliation',
      }),
    );
    expect(lateReinstatement).toMatchObject({ outcome: 'duplicate_effect' });

    expect((await ledger()).map((e) => e.kind)).toEqual([
      'payment',
      'reversal',
      'payment',
      'reversal',
    ]);
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('withdrawn');
  });

  it('writes nothing for a reinstatement of a different amount, and flags it beside the open withdrawal', async () => {
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
    );

    const result = await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', {
        amountCents: 20000,
        occurredAt: day(20),
      }),
    );

    expect(result).toMatchObject({ outcome: 'exception', ledgerEntryId: null });
    expect((await ledger()).map((e) => e.kind)).toEqual([
      'payment',
      'reversal',
    ]);
    expect((await paymentRow('pay-1'))?.ledger_state).toBe('withdrawn');
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'funds_withdrawn',
      'amount_mismatch',
    ]);
  });

  it('records a reinstatement with nothing withdrawn without touching the ledger', async () => {
    // A failed partial refund: the partial never reached the ledger, so
    // nothing comes back onto it, and the partial's own exception stays open.
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        amountCents: 10000,
        occurredAt: day(3),
      }),
    );

    const result = await applyPaymentEvent(
      env,
      fakeEvent('funds_reinstated', 'ref_pay-1', {
        amountCents: 10000,
        occurredAt: day(5),
      }),
    );

    expect(result).toMatchObject({ outcome: 'applied', ledgerEntryId: null });
    expect((await ledger()).map((e) => e.kind)).toEqual(['payment']);
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'partial_withdrawal',
    ]);
  });
});

describe('a dispute', () => {
  it('puts the dispute in front of the board without touching the ledger', async () => {
    await settled();

    const result = await applyPaymentEvent(
      env,
      fakeEvent('dispute_opened', 'ref_pay-1', { occurredAt: day(2) }),
    );

    expect(result).toMatchObject({ outcome: 'exception', ledgerEntryId: null });
    expect((await ledger()).map((e) => e.kind)).toEqual(['payment']);
    expect(await paymentRow('pay-1')).toEqual({
      status: 'succeeded',
      ledger_state: 'credited',
    });
    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'dispute_opened',
    ]);
  });
});

describe('one question for the board, however many paths ask it', () => {
  it.each([
    ['a dispute', 'dispute_opened', 45000],
    ['a partial withdrawal', 'funds_withdrawn', 10000],
  ] as const)(
    'opens one exception for %s a webhook and a pull both report',
    async (_label, type, amountCents) => {
      await settled();
      const fact = { amountCents, occurredAt: day(3) };
      await applyPaymentEvent(env, fakeEvent(type, 'ref_pay-1', fact));

      const pulled = await applyPaymentEvent(
        env,
        fakeEvent(type, 'ref_pay-1', { ...fact, via: 'reconciliation' }),
      );

      expect(pulled).toMatchObject({ outcome: 'duplicate_effect' });
      expect(await openExceptions()).toHaveLength(1);
    },
  );

  it('opens one exception for a withdrawal with nothing credited that two paths report', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await applyPaymentEvent(env, fakeEvent('funds_withdrawn', 'ref_pay-1'));

    const pulled = await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', { via: 'reconciliation' }),
    );

    expect(pulled).toMatchObject({ outcome: 'duplicate_effect' });
    expect(await openExceptions()).toHaveLength(1);
  });

  it('asks again about the same partial withdrawal once the ledger has moved on', async () => {
    // The same amount against a different credit is a different refund.
    await settled();
    const partial = (n: number) =>
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        amountCents: 10000,
        occurredAt: day(n),
      });
    await applyPaymentEvent(env, partial(3));
    for (const [type, n] of [
      ['funds_withdrawn', 4],
      ['funds_reinstated', 20],
    ] as const)
      await applyPaymentEvent(
        env,
        fakeEvent(type, 'ref_pay-1', { occurredAt: day(n) }),
      );

    await applyPaymentEvent(env, partial(25));

    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'partial_withdrawal',
      'partial_withdrawal',
    ]);
  });

  it('asks again about a second partial withdrawal of a different amount', async () => {
    // Two partial refunds are two adjustments for the board to record.
    await settled();
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        amountCents: 10000,
        occurredAt: day(3),
      }),
    );
    await applyPaymentEvent(
      env,
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        amountCents: 5000,
        occurredAt: day(6),
      }),
    );

    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'partial_withdrawal',
      'partial_withdrawal',
    ]);
  });
});

let boardSequence = 0;

/** A payment the board typed in by hand, as the board's ledger route writes one. */
async function boardPayment(
  effectiveDay: string,
  amountCents = 45000,
  lotId = 'lot-a',
) {
  boardSequence += 1;
  const id = `board-${boardSequence}`;
  await env.DATABASE.prepare(
    `INSERT INTO dues_ledger_entries
       (id, lot_id, kind, amount_cents, effective_day, description, category,
        method, reference, source, payment_id, reverses_entry_id, recorded_by,
        recorded_at, operation_key)
     VALUES (?, ?, 'payment', ?, ?, 'Check 1041', NULL, 'check', NULL,
             'board', NULL, NULL, 'board-1', 0, ?)`,
  )
    .bind(id, lotId, -amountCents, effectiveDay, `op-${id}`)
    .run();
  return id;
}

describe('a provider credit that looks like a check the board already entered', () => {
  // The online credit settles on 2026-11-02 (Association Day).
  it('credits it anyway and flags it as a possible duplicate', async () => {
    await boardPayment('2026-10-19');
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    const result = await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1'),
    );

    expect(result).toMatchObject({ outcome: 'exception' });
    expect((await ledger()).map((e) => e.source)).toEqual([
      'board',
      'provider',
    ]);
    expect(await openExceptions()).toEqual([
      {
        reason: 'possible_duplicate',
        payment_id: 'pay-1',
        provider_event_id: 'evt_1',
      },
    ]);
  });

  it.each([
    ['entered more than 14 days before', () => boardPayment('2026-10-18')],
    ['dated after the credit', () => boardPayment('2026-11-03')],
    ['of a different amount', () => boardPayment('2026-11-01', 40000)],
    ['on another Lot', () => boardPayment('2026-11-01', 45000, 'lot-b')],
  ])('does not flag a board payment %s', async (_label, seed) => {
    await seed();
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    const result = await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1'),
    );

    expect(result).toMatchObject({ outcome: 'applied' });
    expect(await openExceptions()).toEqual([]);
  });

  it('does not flag a board payment the board already reversed', async () => {
    // A bounced check, reversed: the online payment replaces it, not repeats it.
    const check = await boardPayment('2026-10-30');
    await env.DATABASE.prepare(
      `INSERT INTO dues_ledger_entries
         (id, lot_id, kind, amount_cents, effective_day, description, category,
          method, reference, source, payment_id, reverses_entry_id,
          recorded_by, recorded_at, operation_key)
       VALUES ('bounce', 'lot-a', 'reversal', 45000, '2026-10-31',
               'Check returned', NULL, NULL, NULL, 'board', NULL, ?, 'board-1',
               0, 'op-bounce')`,
    )
      .bind(check)
      .run();
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_pay-1'));

    expect(await openExceptions()).toEqual([]);
  });
});

describe('facts that arrive together, or for a payment the site never started', () => {
  it('follows a whole cycle reported in one pull, stamped with one receipt time', async () => {
    // A reconciliation run applies several facts with the same clock; the
    // order they were applied in, not the clock, decides what is current.
    const pulledAt = new Date('2026-12-01T07:00:00Z');
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    for (const [type, n, amountCents] of [
      ['payment_succeeded', 0, 45000],
      ['funds_withdrawn', 3, 10000],
      ['funds_withdrawn', 4, 45000],
      ['funds_reinstated', 20, 45000],
      ['funds_withdrawn', 25, 10000],
      ['funds_withdrawn', 30, 45000],
    ] as const)
      await applyPaymentEvent(
        env,
        fakeEvent(type, 'ref_pay-1', {
          amountCents,
          occurredAt: day(n),
          via: 'reconciliation',
        }),
        pulledAt,
      );

    const entries = await ledger();
    expect(entries.map((e) => [e.kind, e.amountCents])).toEqual([
      ['payment', -45000],
      ['reversal', 45000],
      ['payment', -45000],
      ['reversal', 45000],
    ]);
    // Each withdrawal reversed the credit current when it happened.
    expect(entries[1]?.reversesEntryId).toBe(entries[0]?.id);
    expect(entries[3]?.reversesEntryId).toBe(entries[2]?.id);
    // The second partial is against a different credit, so it is asked again.
    expect(
      (await openExceptions()).filter((x) => x.reason === 'partial_withdrawal'),
    ).toHaveLength(2);
  });

  it.each(['funds_withdrawn', 'dispute_opened', 'funds_reinstated'] as const)(
    'puts an unmatched %s in front of the board, since money moved',
    async (type) => {
      const result = await applyPaymentEvent(
        env,
        fakeEvent(type, 'ref_unknown'),
      );

      expect(result).toMatchObject({ outcome: 'unmatched' });
      expect(await ledger()).toEqual([]);
      expect((await openExceptions()).map((x) => x.reason)).toEqual([
        'unmatched_payment',
      ]);
    },
  );

  it('asks about money leaving an unmatched payment as well as its arrival', async () => {
    await applyPaymentEvent(env, fakeEvent('payment_succeeded', 'ref_unknown'));
    await applyPaymentEvent(env, fakeEvent('funds_withdrawn', 'ref_unknown'));

    expect((await openExceptions()).map((x) => x.reason)).toEqual([
      'unmatched_payment',
      'unmatched_payment',
    ]);
  });

  it.each(['funds_withdrawn', 'funds_reinstated', 'dispute_opened'] as const)(
    'stores a redelivered %s once',
    async (type) => {
      await settled();
      if (type === 'funds_reinstated')
        await applyPaymentEvent(
          env,
          fakeEvent('funds_withdrawn', 'ref_pay-1', { occurredAt: day(3) }),
        );
      const event = fakeEvent(type, 'ref_pay-1', { occurredAt: day(20) });
      await applyPaymentEvent(env, event);
      const before = await ledger();

      expect(await applyPaymentEvent(env, event)).toEqual({
        kind: 'duplicate_event',
      });
      expect(await ledger()).toEqual(before);
    },
  );

  it('reverses once when two reports of a withdrawal race each other', async () => {
    await settled();

    await Promise.all(
      (['webhook', 'reconciliation'] as const).map((via) =>
        applyPaymentEvent(
          env,
          fakeEvent('funds_withdrawn', 'ref_pay-1', {
            occurredAt: day(3),
            via,
          }),
        ),
      ),
    );

    expect((await ledger()).map((e) => e.kind)).toEqual([
      'payment',
      'reversal',
    ]);
    expect(await openExceptions()).toHaveLength(1);
  });

  it.each([
    ['a dispute', 'dispute_opened', 45000],
    ['a partial withdrawal', 'funds_withdrawn', 10000],
  ] as const)(
    'opens one exception when two reports of %s race each other',
    async (_label, type, amountCents) => {
      await settled();

      await Promise.all(
        (['webhook', 'reconciliation'] as const).map((via) =>
          applyPaymentEvent(
            env,
            fakeEvent(type, 'ref_pay-1', {
              amountCents,
              occurredAt: day(3),
              via,
            }),
          ),
        ),
      );

      expect(await storedEvents()).toHaveLength(3);
      expect(await openExceptions()).toHaveLength(1);
    },
  );
});
