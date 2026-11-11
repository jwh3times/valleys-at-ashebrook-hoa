import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/payments';
import { setPaymentProviderForTests } from '../../src/server/payments/registry';
import { applyPaymentEvent } from '../../src/server/payments/apply';
import { paymentReference } from '../../src/lib/payments';
import type { NormalizedPaymentEvent } from '../../src/server/payments/provider';
import type {
  AdminOpenPaymentException,
  AdminPaymentDetail,
  AdminPaymentSummary,
} from '../../src/lib/types';
import { callerContext } from './caller-context';
import { seedLotAuthority, seedProperty, truncateAll } from './fixtures';
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
 * The board's payments surface (ADR 0025, #545): the board answers "I paid,
 * and the ledger says I didn't".
 *
 * Observed as the board sees it — the status code, the JSON it reads — and by
 * what exists afterwards: the payment and resolution rows, the stored facts,
 * the Lot's ledger. Never by which helper ran.
 */

const board = callerContext('board-1', 'board', []);
const homeowner = callerContext('owner-1', 'homeowner', ['lot-a']);

const KEY_1 = '11111111-1111-4111-8111-111111111111';
const KEY_2 = '22222222-2222-4222-8222-222222222222';

function get(query = '', ctx: ReturnType<typeof callerContext> | null = board) {
  return GET({
    request: new Request(`http://localhost/api/admin/payments${query}`),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

function post(
  body: unknown,
  ctx: ReturnType<typeof callerContext> | null = board,
) {
  return POST({
    request: new Request('http://localhost/api/admin/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

type Listing = {
  payments: AdminPaymentSummary[];
  exceptions: AdminOpenPaymentException[];
};
const listing = async (res: Response) => (await res.json()) as Listing;

async function setSite(flags: Record<string, unknown>) {
  await env.DATABASE.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(flags), Date.now())
    .run();
}

let fake: ReturnType<typeof fakeProvider>;
const useFake = (options: Parameters<typeof fakeProvider>[0] = {}) => {
  fake = fakeProvider(options);
  setPaymentProviderForTests(fake);
};

async function ledger(lotId?: string) {
  const { results } = await env.DATABASE.prepare(
    `SELECT lot_id, kind, amount_cents, payment_id, source
       FROM dues_ledger_entries
      ${lotId ? 'WHERE lot_id = ?' : ''}
      ORDER BY rowid`,
  )
    .bind(...(lotId ? [lotId] : []))
    .all<{
      lot_id: string;
      kind: string;
      amount_cents: number;
      payment_id: string | null;
      source: string;
    }>();
  return results;
}

async function resolutions() {
  const { results } = await env.DATABASE.prepare(
    `SELECT r.id, x.reason, r.resolution, r.note, r.acting_account_id
       FROM payment_exception_resolutions r
       JOIN payment_exceptions x ON x.id = r.exception_id
      ORDER BY r.rowid`,
  ).all<{
    id: string;
    reason: string;
    resolution: string;
    note: string | null;
    acting_account_id: string | null;
  }>();
  return results;
}

/** The id of the one exception open for `reason`. */
async function exceptionId(reason: string): Promise<string> {
  const row = await env.DATABASE.prepare(
    `SELECT id FROM payment_exceptions WHERE reason = ? ORDER BY rowid DESC`,
  )
    .bind(reason)
    .first<{ id: string }>();
  if (!row) throw new Error(`no ${reason} exception`);
  return row.id;
}

const record = (event: NormalizedPaymentEvent) =>
  applyPaymentEvent(env, event, new Date('2026-11-02T16:00:00Z'));

/** A payment taken outside the site — a Payment Link sale, say. */
async function unmatchedSale(
  overrides: Partial<NormalizedPaymentEvent> = {},
): Promise<string> {
  await record(
    fakeEvent('payment_succeeded', 'ref_link_1', {
      amountCents: 30000,
      ...overrides,
    }),
  );
  return exceptionId('unmatched_payment');
}

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
  await setSite({ officialMode: true, lotRecordsEnabled: true });
  useFake();
});

afterEach(() => {
  setPaymentProviderForTests(null);
});

describe('who may use the board payments surface', () => {
  it('refuses an anonymous caller before anything else', async () => {
    setPaymentProviderForTests(null);
    expect((await get('', null)).status).toBe(401);
    expect((await post({ action: 'resync' }, null)).status).toBe(401);
  });

  it('refuses a homeowner who is not on the board', async () => {
    expect((await get('', homeowner)).status).toBe(403);
    expect((await post({ action: 'resync' }, homeowner)).status).toBe(403);
  });

  it('is absent while no payment provider is configured', async () => {
    setPaymentProviderForTests(null);
    expect((await get()).status).toBe(404);
    expect((await post({ action: 'resync', paymentId: 'x' })).status).toBe(404);
  });

  it('stays readable with Lot Records switched off, since ingestion never stops', async () => {
    await setSite({ officialMode: false, lotRecordsEnabled: false });
    expect((await get()).status).toBe(200);
  });

  it('holds writes during the write freeze', async () => {
    await env.DATABASE.prepare(
      "INSERT INTO cutover_settings (key, value, updated_at) VALUES ('write_freeze', 'on', 1)",
    ).run();
    expect((await post({ action: 'resync', paymentId: 'x' })).status).toBe(503);
  });
});

describe('the list of payments', () => {
  it('lists every payment, newest first, with its open exceptions counted', async () => {
    await seedPayment({
      id: 'pay-old',
      lotId: 'lot-a',
      createdAt: '2026-10-01T12:00:00Z',
    });
    await seedPayment({
      id: 'pay-new',
      lotId: 'lot-b',
      amountCents: 12500,
      status: 'pending',
      createdAt: '2026-11-01T12:00:00Z',
    });
    await record(
      fakeEvent('payment_succeeded', 'ref_pay-old', { amountCents: 40000 }),
    );

    const res = await get();
    expect(res.status).toBe(200);
    const body = await listing(res);
    expect(body.payments).toEqual([
      {
        id: 'pay-new',
        lotId: 'lot-b',
        amountCents: 12500,
        origin: 'checkout',
        status: 'pending',
        ledgerState: 'none',
        providerPaymentRef: 'ref_pay-new',
        createdAt: '2026-11-01T12:00:00.000Z',
        openExceptions: 0,
      },
      {
        id: 'pay-old',
        lotId: 'lot-a',
        amountCents: 45000,
        origin: 'checkout',
        status: 'succeeded',
        ledgerState: 'credited',
        providerPaymentRef: 'ref_pay-old',
        createdAt: '2026-10-01T12:00:00.000Z',
        openExceptions: 1,
      },
    ]);
  });

  it('filters by Lot and by status', async () => {
    await seedPayment({ id: 'pay-a', lotId: 'lot-a', status: 'pending' });
    await seedPayment({ id: 'pay-b', lotId: 'lot-b', status: 'pending' });
    await seedPayment({ id: 'pay-c', lotId: 'lot-a', status: 'failed' });

    const ids = async (query: string) =>
      (await listing(await get(query))).payments.map((p) => p.id);
    expect((await ids('?lotId=lot-a')).sort()).toEqual(['pay-a', 'pay-c']);
    expect((await ids('?status=pending')).sort()).toEqual(['pay-a', 'pay-b']);
    expect(await ids('?lotId=lot-a&status=pending')).toEqual(['pay-a']);
  });

  it('refuses a status that is not one', async () => {
    expect((await get('?status=paid')).status).toBe(400);
  });

  it('carries the queue of open exceptions, unmatched facts included', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await record(fakeEvent('dispute_opened', 'ref_pay-1'));
    await unmatchedSale();

    const { exceptions } = await listing(await get('?lotId=lot-b'));
    expect(exceptions).toEqual([
      expect.objectContaining({
        reason: 'dispute_opened',
        paymentId: 'pay-1',
        lotId: 'lot-a',
        providerPaymentRef: 'ref_pay-1',
        applicable: false,
      }),
      expect.objectContaining({
        reason: 'unmatched_payment',
        paymentId: null,
        lotId: null,
        providerPaymentRef: 'ref_link_1',
        fact: {
          type: 'payment_succeeded',
          amountCents: 30000,
          currency: 'usd',
          occurredAt: '2026-11-02T15:00:00.000Z',
        },
        applicable: true,
      }),
    ]);
  });

  it('leaves a resolved exception out of the queue', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await record(fakeEvent('dispute_opened', 'ref_pay-1'));
    await post({
      action: 'resolveException',
      exceptionId: await exceptionId('dispute_opened'),
      resolution: 'reviewed_no_action',
      operationKey: KEY_1,
    });
    const after = await listing(await get());
    expect(after.exceptions).toEqual([]);
    expect(after.payments.map((p) => p.openExceptions)).toEqual([0]);
  });
});

describe("one payment's detail", () => {
  it('shows its facts, the entries they wrote, and its exceptions with how each closed', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await record(
      fakeEvent('payment_succeeded', 'ref_pay-1', { providerEventId: 'e1' }),
    );
    // Two equal partial refunds raise one exception (#545's comment), so the
    // board must see both facts, not only the exception.
    await record(
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        providerEventId: 'e2',
        amountCents: 22500,
      }),
    );
    await record(
      fakeEvent('funds_withdrawn', 'ref_pay-1', {
        providerEventId: 'e3',
        amountCents: 22500,
      }),
    );
    await post({
      action: 'resolveException',
      exceptionId: await exceptionId('partial_withdrawal'),
      resolution: 'corrected_by_entry',
      note: 'Adjusted by hand',
      operationKey: KEY_1,
    });

    const res = await get('?id=pay-1');
    expect(res.status).toBe(200);
    const detail = (await res.json()) as AdminPaymentDetail;
    expect(detail.id).toBe('pay-1');
    expect(detail.status).toBe('succeeded');
    expect(detail.events.map((e) => [e.providerEventId, e.type])).toEqual([
      ['e1', 'payment_succeeded'],
      ['e2', 'funds_withdrawn'],
      ['e3', 'funds_withdrawn'],
    ]);
    const credit = detail.events[0]!;
    expect(credit).toMatchObject({
      amountCents: 45000,
      currency: 'usd',
      via: 'webhook',
      outcome: 'applied',
    });
    expect(detail.entries).toEqual([
      expect.objectContaining({
        id: credit.ledgerEntryId,
        kind: 'payment',
        amountCents: -45000,
        effectiveDay: '2026-11-02',
        description: 'Online payment',
      }),
    ]);
    expect(detail.exceptions).toEqual([
      expect.objectContaining({
        reason: 'partial_withdrawal',
        resolution: expect.objectContaining({
          resolution: 'corrected_by_entry',
          note: 'Adjusted by hand',
          actingAccountId: 'board-1',
        }),
      }),
    ]);
  });

  it('answers 404 for a payment that does not exist', async () => {
    expect((await get('?id=nope')).status).toBe(404);
  });

  it('refuses an empty id rather than listing everything', async () => {
    expect((await get('?id=')).status).toBe(400);
  });
});

describe('re-syncing one payment from the provider', () => {
  const pulled = (
    ref: string,
    overrides: Partial<NormalizedPaymentEvent> = {},
  ) =>
    fakeEvent('payment_succeeded', ref, {
      providerEventId: `reconciliation:${ref}:payment_succeeded`,
      via: 'reconciliation',
      ...overrides,
    });

  it('records what the provider reports, crediting the Lot', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'pending' });
    useFake({ pulls: { 'ref_pay-1': [pulled('ref_pay-1')] } });

    const res = await post({ action: 'resync', paymentId: 'pay-1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 1 });
    expect(fake.pulledRefs).toEqual(['ref_pay-1']);
    expect(await paymentRow('pay-1')).toEqual({
      status: 'succeeded',
      ledger_state: 'credited',
    });
    expect(await ledger()).toEqual([
      {
        lot_id: 'lot-a',
        kind: 'payment',
        amount_cents: -45000,
        payment_id: 'pay-1',
        source: 'provider',
      },
    ]);
  });

  it('credits once when the webhook already recorded the settlement', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await record(fakeEvent('payment_succeeded', 'ref_pay-1'));
    useFake({ pulls: { 'ref_pay-1': [pulled('ref_pay-1')] } });

    const res = await post({ action: 'resync', paymentId: 'pay-1' });

    expect(await res.json()).toEqual({ recorded: 1 });
    expect(await ledger()).toHaveLength(1);
    expect((await storedEvents()).map((e) => e.outcome)).toEqual([
      'applied',
      'duplicate_effect',
    ]);
  });

  it('records nothing new when asked twice', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    useFake({ pulls: { 'ref_pay-1': [pulled('ref_pay-1')] } });
    await post({ action: 'resync', paymentId: 'pay-1' });

    const again = await post({ action: 'resync', paymentId: 'pay-1' });

    expect(await again.json()).toEqual({ recorded: 0 });
    expect(fake.pulledRefs).toEqual(['ref_pay-1', 'ref_pay-1']);
    expect(await ledger()).toHaveLength(1);
  });

  it('pulls a payment that already settled, with no rate limit', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', status: 'succeeded' });
    await post({ action: 'resync', paymentId: 'pay-1' });
    await post({ action: 'resync', paymentId: 'pay-1' });
    expect(fake.pulledRefs).toEqual(['ref_pay-1', 'ref_pay-1']);
  });

  it('answers 502 and changes nothing when the provider cannot be reached', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    useFake({ pulls: { 'ref_pay-1': new Error('down') } });

    const res = await post({ action: 'resync', paymentId: 'pay-1' });

    expect(res.status).toBe(502);
    expect(await storedEvents()).toEqual([]);
  });

  it('refuses a payment of another provider without asking anyone', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', provider: 'other' });
    const res = await post({ action: 'resync', paymentId: 'pay-1' });
    expect(res.status).toBe(409);
    expect(fake.pulledRefs).toEqual([]);
  });

  it('refuses a payment with no reference to ask about', async () => {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a', ref: null });
    expect((await post({ action: 'resync', paymentId: 'pay-1' })).status).toBe(
      409,
    );
  });

  it('answers 404 for an unknown payment and 400 without one', async () => {
    expect((await post({ action: 'resync', paymentId: 'nope' })).status).toBe(
      404,
    );
    expect((await post({ action: 'resync' })).status).toBe(400);
  });
});

describe('resolving an exception', () => {
  async function disputed() {
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await record(fakeEvent('dispute_opened', 'ref_pay-1'));
    return exceptionId('dispute_opened');
  }

  const resolve = (overrides: Record<string, unknown>) =>
    post({
      action: 'resolveException',
      resolution: 'reviewed_no_action',
      operationKey: KEY_1,
      ...overrides,
    });

  it('appends a resolution naming the acting account, and closes the exception', async () => {
    const id = await disputed();

    const res = await resolve({ exceptionId: id, note: '  Spoke to owner  ' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: KEY_1 });
    expect(await resolutions()).toEqual([
      {
        id: KEY_1,
        reason: 'dispute_opened',
        resolution: 'reviewed_no_action',
        note: 'Spoke to owner',
        acting_account_id: 'board-1',
      },
    ]);
    expect(await openExceptions()).toEqual([]);
  });

  it('stores a blank note as no note', async () => {
    const id = await disputed();
    await resolve({ exceptionId: id, note: '   ' });
    expect((await resolutions())[0]?.note).toBeNull();
  });

  it('answers a retry of the same submission as already recorded, writing nothing', async () => {
    const id = await disputed();
    await resolve({ exceptionId: id });

    const retry = await resolve({ exceptionId: id });

    expect(retry.status).toBe(409);
    expect(await retry.text()).toMatch(/already recorded/);
    expect(await resolutions()).toHaveLength(1);
  });

  it('refuses a second resolution of the same exception', async () => {
    const id = await disputed();
    await resolve({ exceptionId: id });

    const second = await resolve({
      exceptionId: id,
      resolution: 'corrected_by_entry',
      operationKey: KEY_2,
    });

    expect(second.status).toBe(409);
    expect(await second.text()).toMatch(/already been resolved/);
    expect(await resolutions()).toEqual([
      expect.objectContaining({ resolution: 'reviewed_no_action' }),
    ]);
  });

  it('refuses a key already used to resolve a different exception', async () => {
    const first = await disputed();
    await seedPayment({ id: 'pay-2', lotId: 'lot-b' });
    await record(fakeEvent('dispute_opened', 'ref_pay-2'));
    const second = await exceptionId('dispute_opened');
    expect(second).not.toBe(first);
    await resolve({ exceptionId: first });

    const res = await resolve({ exceptionId: second });

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already been used/);
    expect(await resolutions()).toHaveLength(1);
  });

  it('requires a note for "other", the only record of what was decided', async () => {
    const id = await disputed();
    const res = await resolve({ exceptionId: id, resolution: 'other' });
    expect(res.status).toBe(400);
    expect(await resolutions()).toEqual([]);
    expect(
      (
        await resolve({
          exceptionId: id,
          resolution: 'other',
          note: 'Owner paid by check instead',
        })
      ).status,
    ).toBe(201);
  });

  it('refuses the resolutions only the system or the apply action write', async () => {
    const id = await disputed();
    for (const resolution of ['applied_to_lot', 'funds_reinstated', 'fixed'])
      expect((await resolve({ exceptionId: id, resolution })).status).toBe(400);
    expect(await resolutions()).toEqual([]);
  });

  it('refuses an over-long note, a note that is not text, and a missing or malformed key', async () => {
    const id = await disputed();
    expect(
      (await resolve({ exceptionId: id, note: 'x'.repeat(2001) })).status,
    ).toBe(400);
    expect((await resolve({ exceptionId: id, note: 42 })).status).toBe(400);
    expect(
      (await resolve({ exceptionId: id, operationKey: undefined })).status,
    ).toBe(400);
    expect(
      (await resolve({ exceptionId: id, operationKey: 'provider:x' })).status,
    ).toBe(400);
    expect(await resolutions()).toEqual([]);
  });

  it('answers 404 for an exception that does not exist', async () => {
    expect((await resolve({ exceptionId: 'nope' })).status).toBe(404);
  });
});

describe('applying a payment taken outside the site to a Lot', () => {
  const applyTo = (exception: string, lotId = 'lot-b', operationKey = KEY_1) =>
    post({
      action: 'applyUnmatched',
      exceptionId: exception,
      lotId,
      operationKey,
    });

  it('credits the Lot once, as a board-applied payment, and resolves the exception', async () => {
    const id = await unmatchedSale();

    const res = await applyTo(id);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ paymentId: KEY_1 });
    expect(await ledger()).toEqual([
      {
        lot_id: 'lot-b',
        kind: 'payment',
        amount_cents: -30000,
        payment_id: KEY_1,
        source: 'provider',
      },
    ]);
    const payment = await env.DATABASE.prepare(
      `SELECT lot_id, amount_cents, origin, initiated_by_person_id, provider,
              provider_payment_ref, status, ledger_state
         FROM payments WHERE id = ?`,
    )
      .bind(KEY_1)
      .first();
    expect(payment).toEqual({
      lot_id: 'lot-b',
      amount_cents: 30000,
      origin: 'board_applied',
      initiated_by_person_id: null,
      provider: 'fake',
      provider_payment_ref: 'ref_link_1',
      status: 'succeeded',
      ledger_state: 'credited',
    });
    expect(await resolutions()).toEqual([
      {
        id: KEY_1,
        reason: 'unmatched_payment',
        resolution: 'applied_to_lot',
        note: null,
        acting_account_id: 'board-1',
      },
    ]);
    // The original fact stays as it was received; the replay is the board's.
    expect(
      (await storedEvents()).map((e) => [e.payment_id, e.outcome, e.via]),
    ).toEqual([
      [null, 'unmatched', 'webhook'],
      [KEY_1, 'applied', 'board'],
    ]);
  });

  it('writes nothing when applied again, under the same key or another', async () => {
    const id = await unmatchedSale();
    await applyTo(id);

    const retry = await applyTo(id);
    const other = await applyTo(id, 'lot-a', KEY_2);

    expect(retry.status).toBe(409);
    expect(await retry.text()).toMatch(/already recorded/);
    expect(other.status).toBe(409);
    expect(await other.text()).toMatch(/already been resolved/);
    expect(await ledger()).toHaveLength(1);
    expect(
      (await env.DATABASE.prepare('SELECT COUNT(*) AS n FROM payments').first())
        ?.n,
    ).toBe(1);
  });

  it('matches later facts about the same sale to the applied payment', async () => {
    const id = await unmatchedSale();
    await applyTo(id);

    await record(
      fakeEvent('funds_withdrawn', 'ref_link_1', { amountCents: 30000 }),
    );

    expect((await ledger('lot-b')).map((l) => l.amount_cents)).toEqual([
      -30000, 30000,
    ]);
    expect(await openExceptions()).toEqual([
      expect.objectContaining({ reason: 'funds_withdrawn', payment_id: KEY_1 }),
    ]);
  });

  it('finishes an apply that stopped after creating its payment', async () => {
    const id = await unmatchedSale();
    // What an apply interrupted after its first write leaves behind.
    await seedPayment({
      id: KEY_1,
      lotId: 'lot-b',
      amountCents: 30000,
      personId: null,
      ref: 'ref_link_1',
    });

    const res = await applyTo(id, 'lot-b', KEY_2);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ paymentId: KEY_1 });
    expect(await ledger()).toEqual([
      expect.objectContaining({ lot_id: 'lot-b', payment_id: KEY_1 }),
    ]);
    expect(await openExceptions()).toEqual([]);
  });

  it("refuses when the reference already belongs to a homeowner's payment, even on the same Lot", async () => {
    const id = await unmatchedSale();
    await seedPayment({ id: 'pay-1', lotId: 'lot-b', ref: 'ref_link_1' });

    const res = await applyTo(id);

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/belongs to another payment/);
    expect(await ledger()).toEqual([]);
    expect(await resolutions()).toEqual([]);
  });

  it('does not finish an interrupted apply onto a different Lot', async () => {
    const id = await unmatchedSale();
    await seedPayment({
      id: KEY_1,
      lotId: 'lot-a',
      amountCents: 30000,
      personId: null,
      ref: 'ref_link_1',
    });

    const res = await applyTo(id, 'lot-b', KEY_2);

    expect(res.status).toBe(409);
    expect(await ledger()).toEqual([]);
    expect(await openExceptions()).toHaveLength(1);
  });

  it('re-checks the Lot Records flags inside its write', async () => {
    const id = await unmatchedSale();
    await setSite({ officialMode: true, lotRecordsEnabled: false });

    const res = await applyTo(id);

    expect(res.status).toBe(409);
    expect(await ledger()).toEqual([]);
    expect(
      (await env.DATABASE.prepare('SELECT COUNT(*) AS n FROM payments').first())
        ?.n,
    ).toBe(0);
    expect(await openExceptions()).toHaveLength(1);
  });

  it('refuses a Lot that does not exist', async () => {
    const id = await unmatchedSale();
    expect((await applyTo(id, 'lot-zzz')).status).toBe(409);
    expect(await ledger()).toEqual([]);
  });

  it('refuses facts that are not a settled sale in US dollars with a reference', async () => {
    await record(
      fakeEvent('payment_succeeded', 'ref_eur', { currency: 'eur' }),
    );
    const euro = await exceptionId('unmatched_payment');
    await record(fakeEvent('funds_withdrawn', 'ref_gone'));
    const withdrawal = await exceptionId('unmatched_payment');
    await record(fakeEvent('payment_succeeded', null));
    const noRef = await exceptionId('unmatched_payment');
    await seedPayment({ id: 'pay-1', lotId: 'lot-a' });
    await record(fakeEvent('dispute_opened', 'ref_pay-1'));
    const dispute = await exceptionId('dispute_opened');

    for (const id of [euro, withdrawal, noRef, dispute])
      expect((await applyTo(id)).status).toBe(409);
    expect(await ledger()).toEqual([]);
    expect(await resolutions()).toEqual([]);
  });

  it('flags a look-alike of a check the board entered, as any settlement does', async () => {
    const id = await unmatchedSale();
    await env.DATABASE.prepare(
      `INSERT INTO dues_ledger_entries
         (id, lot_id, kind, amount_cents, effective_day, description, category,
          method, reference, source, payment_id, reverses_entry_id, recorded_by,
          recorded_at, operation_key)
       VALUES ('chk-1', 'lot-b', 'payment', -30000, '2026-10-30', 'Check', NULL,
               'check', NULL, 'board', NULL, NULL, 'board-1', 1, 'op-chk')`,
    ).run();

    await applyTo(id);

    expect(await openExceptions()).toEqual([
      expect.objectContaining({
        reason: 'possible_duplicate',
        payment_id: KEY_1,
      }),
    ]);
  });

  it('answers 404 for an unknown exception, and 400 without a Lot or key', async () => {
    expect((await applyTo('nope')).status).toBe(404);
    const id = await unmatchedSale();
    expect(
      (
        await post({
          action: 'applyUnmatched',
          exceptionId: id,
          operationKey: KEY_1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          action: 'applyUnmatched',
          exceptionId: id,
          lotId: 'lot-b',
        })
      ).status,
    ).toBe(400);
  });
});

describe("exporting provider-sourced entries for the treasurer's bank reconciliation", () => {
  // The provider's id and the site's Payment Reference side by side (#562),
  // so a row matches both the provider's records and the homeowner's receipt.
  const HEADER =
    'Effective day,Lot,Kind,Amount,Provider reference,Payment Reference,Entry id';

  /** A settled online payment for `lotId`, credited on the Association Day of `at`. */
  async function settled(
    id: string,
    lotId: string,
    at: string,
    overrides: Partial<NormalizedPaymentEvent> = {},
  ) {
    await seedPayment({ id, lotId });
    await record(
      fakeEvent('payment_succeeded', `ref_${id}`, {
        occurredAt: new Date(at),
        ...overrides,
      }),
    );
  }

  /** The id of the ledger entry a payment's settlement wrote. */
  async function entryOf(paymentId: string, kind = 'payment') {
    const row = await env.DATABASE.prepare(
      `SELECT id FROM dues_ledger_entries WHERE payment_id = ? AND kind = ?`,
    )
      .bind(paymentId, kind)
      .first<{ id: string }>();
    if (!row) throw new Error(`no ${kind} entry for ${paymentId}`);
    return row.id;
  }

  const exportRange = (from: unknown, to: unknown, ctx = board) =>
    post({ action: 'export', from, to }, ctx);

  it('answers CSV of each entry the provider wrote in the range', async () => {
    const id = 'de501dc2-7a1b-4c3d-9e8f-0a1b2c3d4e5f';
    await settled(id, 'lot-a', '2026-11-02T15:00:00Z');

    const res = await exportRange('2026-11-01', '2026-11-30');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    // Per-Lot money and addresses: no cache may keep a copy.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(
      `${HEADER}\r\n` +
        `2026-11-02,lot-a Ashebrook Lane,Payment,-450.00,ref_${id},DE50-1DC2,${await entryOf(id)}\r\n`,
    );
  });

  it('includes both ends of the range, and nothing outside it or recorded by the board', async () => {
    await settled('pay-before', 'lot-a', '2026-10-31T16:00:00Z');
    await settled('pay-first', 'lot-a', '2026-11-01T16:00:00Z');
    await settled('pay-last', 'lot-b', '2026-11-30T16:00:00Z');
    await settled('pay-after', 'lot-b', '2026-12-01T16:00:00Z');
    // A check the board recorded by hand, inside the range.
    await env.DATABASE.prepare(
      `INSERT INTO dues_ledger_entries
         (id, lot_id, kind, amount_cents, effective_day, description, method,
          source, recorded_by, recorded_at, operation_key)
       VALUES ('board-check', 'lot-a', 'payment', -10000, '2026-11-15',
               'Check 1001', 'check', 'board', 'board-1', 1, 'board-check')`,
    ).run();

    const res = await exportRange('2026-11-01', '2026-11-30');

    expect(await res.text()).toBe(
      `${HEADER}\r\n` +
        `2026-11-01,lot-a Ashebrook Lane,Payment,-450.00,ref_pay-first,${paymentReference('pay-first')},${await entryOf('pay-first')}\r\n` +
        `2026-11-30,lot-b Ashebrook Lane,Payment,-450.00,ref_pay-last,${paymentReference('pay-last')},${await entryOf('pay-last')}\r\n`,
    );
  });

  it('defuses a cell a spreadsheet would run as a formula, and quotes what needs quoting', async () => {
    await seedProperty('lot-formula', {
      address: '=HYPERLINK("http://x.test","Pay")',
      addressNormalized: 'formula lot',
    });
    await seedProperty('lot-comma', {
      address: '12 Oak Lane, Rear',
      addressNormalized: '12 oak lane rear',
    });
    const sale = async (id: string, lotId: string, ref: string, at: string) => {
      await seedPayment({ id, lotId, ref });
      await record(
        fakeEvent('payment_succeeded', ref, { occurredAt: new Date(at) }),
      );
    };
    await sale('pay-1', 'lot-formula', '-2+3', '2026-11-02T16:00:00Z');
    await sale('pay-2', 'lot-comma', '@SUM(A1)', '2026-11-03T16:00:00Z');
    await sale('pay-3', 'lot-a', '+1', '2026-11-04T16:00:00Z');
    await sale('pay-4', 'lot-a', '\tcmd', '2026-11-05T16:00:00Z');

    const body = await (await exportRange('2026-11-01', '2026-11-30')).text();

    expect(body).toBe(
      `${HEADER}\r\n` +
        `2026-11-02,"'=HYPERLINK(""http://x.test"",""Pay"")",Payment,-450.00,'-2+3,${paymentReference('pay-1')},${await entryOf('pay-1')}\r\n` +
        `2026-11-03,"12 Oak Lane, Rear",Payment,-450.00,'@SUM(A1),${paymentReference('pay-2')},${await entryOf('pay-2')}\r\n` +
        `2026-11-04,lot-a Ashebrook Lane,Payment,-450.00,'+1,${paymentReference('pay-3')},${await entryOf('pay-3')}\r\n` +
        `2026-11-05,lot-a Ashebrook Lane,Payment,-450.00,'\tcmd,${paymentReference('pay-4')},${await entryOf('pay-4')}\r\n`,
    );
  });

  it('renders each amount exactly, with the sign the ledger records', async () => {
    await settled('pay-cent', 'lot-a', '2026-11-02T16:00:00Z', {
      amountCents: 1,
    });
    await settled('pay-odd', 'lot-a', '2026-11-03T16:00:00Z', {
      amountCents: 1005,
    });
    await settled('pay-big', 'lot-b', '2026-11-04T16:00:00Z', {
      amountCents: 99999999,
    });
    // The bank pulled pay-odd back: an exact negation of its credit.
    await record(
      fakeEvent('funds_withdrawn', 'ref_pay-odd', {
        amountCents: 1005,
        occurredAt: new Date('2026-11-05T16:00:00Z'),
      }),
    );

    const rows = (await (await exportRange('2026-11-01', '2026-11-30')).text())
      .split('\r\n')
      .slice(1, -1)
      .map((line) => line.split(','));

    expect(rows.map(([day, , kind, amount]) => [day, kind, amount])).toEqual([
      ['2026-11-02', 'Payment', '-0.01'],
      ['2026-11-03', 'Payment', '-10.05'],
      ['2026-11-04', 'Payment', '-999999.99'],
      ['2026-11-05', 'Reversal', '10.05'],
    ]);
    // The reversal names the payment it reverses, both ways.
    expect(rows[3][4]).toBe('ref_pay-odd');
    expect(rows[3][5]).toBe(paymentReference('pay-odd'));
    expect(rows[3][6]).toBe(await entryOf('pay-odd', 'reversal'));
  });

  it('leaves the Payment Reference empty for a provider entry tied to no payment (#562)', async () => {
    await env.DATABASE.prepare(
      `INSERT INTO dues_ledger_entries
         (id, lot_id, kind, amount_cents, effective_day, description, method,
          source, payment_id, recorded_by, recorded_at, operation_key)
       VALUES ('loose-entry', 'lot-a', 'payment', -10000, '2026-11-15',
               'Online payment', 'online', 'provider', NULL, NULL, 1,
               'loose-entry')`,
    ).run();

    const body = await (await exportRange('2026-11-01', '2026-11-30')).text();

    expect(body).toBe(
      `${HEADER}\r\n` +
        `2026-11-15,lot-a Ashebrook Lane,Payment,-100.00,,,loose-entry\r\n`,
    );
  });

  it('is the board’s alone, and absent with no payment provider', async () => {
    await settled('pay-1', 'lot-a', '2026-11-02T16:00:00Z');

    const asOwner = await exportRange('2026-11-01', '2026-11-30', homeowner);
    expect(asOwner.status).toBe(403);
    expect(await asOwner.text()).not.toContain('ref_pay-1');

    setPaymentProviderForTests(null);
    unconfigurePayments();
    expect((await exportRange('2026-11-01', '2026-11-30')).status).toBe(404);
  });

  it('answers a range with nothing in it with the header alone, not an error', async () => {
    await settled('pay-1', 'lot-a', '2026-11-02T16:00:00Z');

    const res = await exportRange('2026-12-01', '2026-12-31');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`${HEADER}\r\n`);
  });

  it('refuses a range that is not two Association Days, in order', async () => {
    const refusals: [unknown, unknown][] = [
      [undefined, '2026-11-30'],
      ['2026-11-01', undefined],
      ['', '2026-11-30'],
      ['2026-11-1', '2026-11-30'],
      ['2026-11-01T00:00:00Z', '2026-11-30'],
      ['2026-02-31', '2026-03-01'],
      ['2026-11-01', '2026-13-01'],
      [20261101, '2026-11-30'],
      ['2026-11-30', '2026-11-01'],
    ];
    for (const [from, to] of refusals) {
      const res = await exportRange(from, to);
      expect(res.status, `from ${String(from)} to ${String(to)}`).toBe(400);
      expect(res.headers.get('content-type')).not.toContain('text/csv');
    }
  });

  it('takes a one-day range', async () => {
    await settled('pay-1', 'lot-a', '2026-11-02T16:00:00Z');
    await settled('pay-2', 'lot-a', '2026-11-03T16:00:00Z');

    const body = await (await exportRange('2026-11-03', '2026-11-03')).text();

    expect(body).toBe(
      `${HEADER}\r\n` +
        `2026-11-03,lot-a Ashebrook Lane,Payment,-450.00,ref_pay-2,${paymentReference('pay-2')},${await entryOf('pay-2')}\r\n`,
    );
  });
});

describe('the actions the route knows', () => {
  it('refuses an unknown action and a malformed body', async () => {
    expect((await post({ action: 'refund' })).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
  });
});
