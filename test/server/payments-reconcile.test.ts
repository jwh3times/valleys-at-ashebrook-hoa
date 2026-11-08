import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { applyPaymentEvent } from '../../src/server/payments/apply';
import { reconcilePayments } from '../../src/server/payments/reconcile';
import { setPaymentProviderForTests } from '../../src/server/payments/registry';
import { fetchAdminLotDuesLedger } from '../../src/server/lot-records/reads';
import { PUT as putSite } from '../../src/pages/api/admin/site';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';
import { truncateAll, seedProperty, seedLotAuthority } from './fixtures';
import { callerContext } from './caller-context';
import {
  fakeEvent,
  fakeProvider,
  openExceptions,
  paymentRow,
  resetFakeEvents,
  seedPayment,
  storedEvents,
  unconfigurePayments,
} from './payments-fixtures';

/**
 * The daily reconciliation job (ADR 0025, #543): a missed or delayed webhook
 * never loses a payment for more than a day.
 *
 * It reads the provider's events since a stored cursor, then pulls the
 * current state of every payment still `created` or `pending` an hour after
 * it started, both through the application path, so a fact the webhook
 * already delivered changes nothing. A payment still pending ten days after
 * it started goes to the board once.
 *
 * Observed the way the board sees it: the ledger, the stored facts and the
 * open exceptions. What the provider was asked is observed through the fake.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

/** The cron's 07:00 UTC run, six-odd days after the default fixture payment. */
const NOW = new Date('2026-11-08T07:00:00Z');

beforeEach(async () => {
  resetFakeEvents();
  unconfigurePayments();
  await truncateAll();
  await env.DATABASE.prepare('DELETE FROM cutover_settings').run();
  await seedProperty('lot-a');
  await seedLotAuthority('payer-1', 'lot-a', { startDay: '2020-01-01' });
});

afterEach(() => setPaymentProviderForTests(null));

const ledger = () => fetchAdminLotDuesLedger(env, 'lot-a');

const pulled = (
  type: Parameters<typeof fakeEvent>[0],
  ref: string,
  overrides: Parameters<typeof fakeEvent>[2] = {},
) =>
  fakeEvent(type, ref, {
    providerEventId: `pull:${ref}:${type}`,
    via: 'reconciliation',
    ...overrides,
  });

function useProvider(queued: Parameters<typeof fakeProvider>[0] = {}) {
  const provider = fakeProvider(queued);
  setPaymentProviderForTests(provider);
  return provider;
}

describe('a payment whose webhook was dropped', () => {
  it('is credited from the provider event list', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    useProvider({
      listed: [
        fakeEvent('payment_succeeded', 'ref_pay-1', { via: 'reconciliation' }),
      ],
    });

    await reconcilePayments(env, NOW);

    const entries = await ledger();
    expect(entries.map((e) => [e.kind, e.amountCents, e.paymentId])).toEqual([
      ['payment', -45000, 'pay-1'],
    ]);
    expect((await storedEvents()).map((e) => e.via)).toEqual([
      'reconciliation',
    ]);
    expect(await paymentRow('pay-1')).toEqual({
      status: 'succeeded',
      ledger_state: 'credited',
    });
  });

  it('is credited by pulling its state when the provider no longer lists the event', async () => {
    // Stripe keeps events for 30 days; a job down longer than that still finds
    // the payment through its own state.
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-09-20T12:00:00Z',
    });
    const provider = useProvider({
      listed: [],
      pulls: { 'ref_pay-1': [pulled('payment_succeeded', 'ref_pay-1')] },
    });

    await reconcilePayments(env, NOW);

    expect(provider.pulledRefs).toEqual(['ref_pay-1']);
    expect((await ledger()).map((e) => e.amountCents)).toEqual([-45000]);
    expect(await openExceptions()).toEqual([]);
  });

  it('is still credited when the job last ran more than 30 days ago', async () => {
    // Past the provider's event retention the listing has nothing older than
    // 30 days to give, however old the cursor; the pull does not need it.
    useProvider({ listed: [], nextCursor: 'cursor-sept' });
    await reconcilePayments(env, new Date('2026-09-25T07:00:00Z'));
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-09-26T12:00:00Z',
    });
    const later = useProvider({
      listed: [],
      pulls: { 'ref_pay-1': [pulled('payment_succeeded', 'ref_pay-1')] },
    });

    await reconcilePayments(env, NOW);

    expect(later.cursorsAsked).toEqual(['cursor-sept']);
    expect((await ledger()).map((e) => e.paymentId)).toEqual(['pay-1']);
  });

  it('records a payment the pull finds failed or expired, with no credit', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });
    await seedPayment({ id: 'pay-2', lotId: 'lot-a' });
    useProvider({
      pulls: {
        'ref_pay-1': [pulled('payment_failed', 'ref_pay-1')],
        'ref_pay-2': [pulled('payment_canceled', 'ref_pay-2')],
      },
    });

    await reconcilePayments(env, NOW);

    expect(await ledger()).toEqual([]);
    expect((await paymentRow('pay-1'))?.status).toBe('failed');
    expect((await paymentRow('pay-2'))?.status).toBe('canceled');
  });
});

describe('a payment whose webhook arrived', () => {
  it('is untouched when the event list reports the same event again', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    const settled = fakeEvent('payment_succeeded', 'ref_pay-1');
    await applyPaymentEvent(env, settled);
    useProvider({ listed: [{ ...settled, via: 'reconciliation' }] });

    await reconcilePayments(env, NOW);

    expect(await ledger()).toHaveLength(1);
    expect(await storedEvents()).toHaveLength(1);
  });

  it('converges on one credit when the settlement is reported under another event id', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await applyPaymentEvent(
      env,
      fakeEvent('payment_succeeded', 'ref_pay-1'),
      new Date('2026-11-02T15:00:05Z'),
    );
    useProvider({
      listed: [
        fakeEvent('payment_succeeded', 'ref_pay-1', { via: 'reconciliation' }),
      ],
    });

    await reconcilePayments(env, NOW);

    expect(await ledger()).toHaveLength(1);
    expect((await storedEvents()).map((e) => e.outcome)).toEqual([
      'applied',
      'duplicate_effect',
    ]);
  });

  it('is not pulled once it has settled, failed or been canceled', async () => {
    for (const status of ['succeeded', 'failed', 'canceled', 'expired'])
      await seedPayment({ id: `pay-${status}`, lotId: 'lot-a', status });
    const provider = useProvider();

    await reconcilePayments(env, NOW);

    expect(provider.pulledRefs).toEqual([]);
  });
});

describe('which payments are pulled', () => {
  it('pulls created and pending payments, oldest first', async () => {
    await seedPayment({
      id: 'pay-new',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-11-05T12:00:00Z',
    });
    await seedPayment({
      id: 'pay-old',
      lotId: 'lot-a',
      createdAt: '2026-11-02T12:00:00Z',
    });
    const provider = useProvider();

    await reconcilePayments(env, NOW);

    expect(provider.pulledRefs).toEqual(['ref_pay-old', 'ref_pay-new']);
  });

  it('leaves a checkout started within the hour to its webhook', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      createdAt: '2026-11-08T06:15:00Z',
    });
    const provider = useProvider();

    await reconcilePayments(env, NOW);

    expect(provider.pulledRefs).toEqual([]);
  });

  it("never asks this provider about another provider's payment", async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', provider: 'other' });
    const provider = useProvider();

    await reconcilePayments(env, NOW);

    expect(provider.pulledRefs).toEqual([]);
  });

  it('stores each pulled fact once however many days it is pulled', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });
    useProvider({
      pulls: { 'ref_pay-1': [pulled('payment_pending', 'ref_pay-1')] },
    });

    await reconcilePayments(env, NOW);
    await reconcilePayments(env, new Date('2026-11-09T07:00:00Z'));

    expect(await storedEvents()).toHaveLength(1);
  });

  it('keeps pulling the rest when one pull fails, and names the one that failed', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      createdAt: '2026-11-02T12:00:00Z',
    });
    await seedPayment({ id: 'pay-2', lotId: 'lot-a' });
    useProvider({
      pulls: {
        'ref_pay-1': new Error('provider unavailable'),
        'ref_pay-2': [pulled('payment_succeeded', 'ref_pay-2')],
      },
    });

    const run = await reconcilePayments(env, NOW);

    expect(run.failedPulls).toEqual(['pay-1']);
    expect((await ledger()).map((e) => e.paymentId)).toEqual(['pay-2']);
  });
});

describe('a payment still pending after ten days', () => {
  it('goes to the board once, however many days the job runs', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-10-28T12:00:00Z',
    });
    useProvider();

    const first = await reconcilePayments(env, NOW);
    await reconcilePayments(env, new Date('2026-11-09T07:00:00Z'));

    expect(first.stalePending).toEqual(['pay-1']);
    expect(await openExceptions()).toEqual([
      { reason: 'stale_pending', payment_id: 'pay-1', provider_event_id: null },
    ]);
  });

  it('is not reopened after the board resolved it', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-10-28T12:00:00Z',
    });
    useProvider();
    await reconcilePayments(env, NOW);
    await env.DATABASE.prepare(
      `INSERT INTO payment_exception_resolutions
         (id, exception_id, resolution, note, acting_account_id, resolved_at)
       SELECT 'res-1', id, 'reviewed_no_action', 'Bank confirmed it is in flight', 'board-1', 1
         FROM payment_exceptions`,
    ).run();

    const later = await reconcilePayments(
      env,
      new Date('2026-11-09T07:00:00Z'),
    );

    expect(later.stalePending).toEqual([]);
    expect(await openExceptions()).toEqual([]);
  });

  it('is not flagged before ten days, or while it was never accepted', async () => {
    await seedPayment({
      id: 'pay-9-days',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-10-30T12:00:00Z',
    });
    await seedPayment({
      id: 'pay-created',
      lotId: 'lot-a',
      createdAt: '2026-10-20T12:00:00Z',
    });
    useProvider();

    await reconcilePayments(env, NOW);

    expect(await openExceptions()).toEqual([]);
  });

  it('is not flagged when the same run finds it settled', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-10-28T12:00:00Z',
    });
    useProvider({
      pulls: { 'ref_pay-1': [pulled('payment_succeeded', 'ref_pay-1')] },
    });

    await reconcilePayments(env, NOW);

    expect(await openExceptions()).toEqual([]);
  });
});

describe('the event cursor', () => {
  it('starts empty, and the next run reads from where the last one finished', async () => {
    const first = useProvider({ listed: [], nextCursor: 'cursor-1' });
    await reconcilePayments(env, NOW);
    const second = useProvider({ listed: [], nextCursor: 'cursor-2' });
    await reconcilePayments(env, new Date('2026-11-09T07:00:00Z'));

    expect(first.cursorsAsked).toEqual([null]);
    expect(second.cursorsAsked).toEqual(['cursor-1']);
  });

  it('does not advance when the event list cannot be read', async () => {
    useProvider({ listed: [], nextCursor: 'cursor-1' });
    await reconcilePayments(env, NOW);
    useProvider({ listed: new Error('provider unavailable'), nextCursor: 'x' });
    const failed = await reconcilePayments(
      env,
      new Date('2026-11-09T07:00:00Z'),
    );
    const next = useProvider({ listed: [] });
    await reconcilePayments(env, new Date('2026-11-10T07:00:00Z'));

    expect(failed.eventListFailed).toBe(true);
    expect(next.cursorsAsked).toEqual(['cursor-1']);
  });

  it('does not advance past a listed fact that could not be recorded', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    useProvider({
      listed: [
        fakeEvent('payment_succeeded', 'ref_pay-1', {
          via: 'reconciliation',
          amountCents: -1,
        }),
      ],
      nextCursor: 'cursor-1',
    });
    const failed = await reconcilePayments(env, NOW);
    const next = useProvider({ listed: [] });
    await reconcilePayments(env, new Date('2026-11-09T07:00:00Z'));

    expect(failed.eventListFailed).toBe(true);
    expect(next.cursorsAsked).toEqual([null]);
  });

  it('still advances when a pull fails, so one stuck payment cannot pin it', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    useProvider({
      listed: [],
      nextCursor: 'cursor-1',
      pulls: { 'ref_pay-1': new Error('provider unavailable') },
    });
    await reconcilePayments(env, NOW);
    const next = useProvider({ listed: [] });
    await reconcilePayments(env, new Date('2026-11-09T07:00:00Z'));

    expect(next.cursorsAsked).toEqual(['cursor-1']);
  });

  it("starts over when the cursor was another provider's", async () => {
    useProvider({ listed: [], nextCursor: 'cursor-1' });
    await reconcilePayments(env, NOW);
    const other = { ...fakeProvider({ listed: [] }), id: 'other' };
    setPaymentProviderForTests(other);
    const asked: (string | null)[] = [];
    other.listEventsSince = async (cursor) => {
      asked.push(cursor);
      return { events: [], nextCursor: null };
    };

    await reconcilePayments(env, new Date('2026-11-09T07:00:00Z'));

    expect(asked).toEqual([null]);
  });

  it('survives a whole-blob Site Settings save', async () => {
    useProvider({ listed: [], nextCursor: 'cursor-1' });
    await reconcilePayments(env, NOW);

    const saved = (await putSite({
      request: new Request('http://localhost/api/admin/site', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(DEFAULT_SITE_SETTINGS),
      }),
      locals: { authContext: callerContext('board-1', 'board', []) },
    } as never)) as Response;
    const next = useProvider({ listed: [] });
    await reconcilePayments(env, new Date('2026-11-09T07:00:00Z'));

    expect(saved.status).toBe(204);
    expect(next.cursorsAsked).toEqual(['cursor-1']);
  });
});

describe('when the job does nothing', () => {
  it('skips silently with no provider configured', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });

    const run = await reconcilePayments(env, NOW);

    expect(run.skipped).toBe('unconfigured');
    expect(await storedEvents()).toEqual([]);
  });

  it('skips during the write freeze, asking the provider nothing', async () => {
    await seedPayment({
      id: 'pay-1',
      lotId: 'lot-a',
      status: 'pending',
      createdAt: '2026-10-28T12:00:00Z',
    });
    await env.DATABASE.prepare(
      `INSERT INTO cutover_settings (key, value, updated_at)
       VALUES ('write_freeze', 'on', 1)`,
    ).run();
    const provider = useProvider({
      listed: [fakeEvent('payment_succeeded', 'ref_pay-1')],
    });

    const run = await reconcilePayments(env, NOW);

    expect(run.skipped).toBe('frozen');
    expect(provider.cursorsAsked).toEqual([]);
    expect(provider.pulledRefs).toEqual([]);
    expect(await storedEvents()).toEqual([]);
    expect(await openExceptions()).toEqual([]);
  });
});
