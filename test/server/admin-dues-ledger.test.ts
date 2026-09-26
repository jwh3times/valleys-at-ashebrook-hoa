import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/dues-ledger';
import { getDb } from '../../src/server/db/client';
import {
  duesLedgerEntries,
  lotRecordEvents,
  settings,
} from '../../src/server/db/schema';
import { callerContext } from './caller-context';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';
import { seedProperty, truncateAll } from './fixtures';

/**
 * Board entry for the dues ledger (ADR 0025, #295 slice 2).
 *
 * The ledger only ever grows, so most of what is worth testing here is what
 * the route REFUSES: a zero amount, a blank amount, a fractional cent, a
 * payment posted as "online" by hand, a reversal of a reversal, a second post
 * of the same submission. Each of those is a way the balance could become a
 * number nobody meant.
 */

const board = callerContext('board-1', 'board', []);
const homeowner = callerContext('owner-1', 'homeowner', ['lot-a']);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

let keySequence = 0;
const nextKey = () => `op-${++keySequence}`;

function post(
  body: Record<string, unknown>,
  ctx: ReturnType<typeof callerContext> | null = board,
) {
  return POST({
    request: new Request('http://localhost/api/admin/dues-ledger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

function get(query = '', ctx: ReturnType<typeof callerContext> | null = board) {
  const url = `http://localhost/api/admin/dues-ledger${query}`;
  return GET({
    request: new Request(url),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

async function setFlags(officialMode: boolean, lotRecordsEnabled: boolean) {
  const db = getDb(env);
  await db.delete(settings);
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({
      ...DEFAULT_SITE_SETTINGS,
      officialMode,
      lotRecordsEnabled,
    }),
    updatedAt: new Date(),
  });
}

const charge = (overrides: Record<string, unknown> = {}) => ({
  action: 'postCharge',
  lotId: 'lot-a',
  category: 'assessment',
  amountCents: 45000,
  effectiveDay: '2026-01-01',
  description: 'Q1 assessment',
  operationKey: nextKey(),
  ...overrides,
});

const entries = () => getDb(env).select().from(duesLedgerEntries);

beforeEach(async () => {
  keySequence = 0;
  await truncateAll();
  await seedProperty('lot-a');
  await seedProperty('lot-b');
  await setFlags(true, true);
});

describe('gate order', () => {
  it('answers 401 and 403 before it answers 404, even with the feature dark', async () => {
    await setFlags(false, false);
    expect((await post(charge(), null)).status).toBe(401);
    expect((await post(charge(), homeowner)).status).toBe(403);
    expect((await get('', null)).status).toBe(401);
    expect((await get('', homeowner)).status).toBe(403);
  });

  it('answers 404 to the board when either flag is off', async () => {
    for (const [official, records] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      await setFlags(official, records);
      expect((await post(charge())).status).toBe(404);
      expect((await get()).status).toBe(404);
    }
  });
});

describe('posting a charge', () => {
  it('records it as a positive amount with its category', async () => {
    const res = await post(charge());
    expect(res.status).toBe(201);

    const [row] = await entries();
    expect(row.kind).toBe('charge');
    expect(row.amountCents).toBe(45000);
    expect(row.category).toBe('assessment');
    expect(row.source).toBe('board');
    expect(row.recordedBy).toBe('board-1');

    const events = await getDb(env).select().from(lotRecordEvents);
    expect(events).toHaveLength(1);
    expect(events[0].recordType).toBe('dues_ledger_entries');
    expect(events[0].action).toBe('created');
    expect(events[0].actingAccountId).toBe('board-1');
  });

  it('refuses an unknown lot, writing neither entry nor event', async () => {
    const res = await post(charge({ lotId: 'no-such-lot' }));
    expect(res.status).toBe(409);
    expect(await entries()).toHaveLength(0);
    expect(await getDb(env).select().from(lotRecordEvents)).toHaveLength(0);
  });

  it('refuses a category outside the list', async () => {
    expect((await post(charge({ category: 'vibes' }))).status).toBe(400);
  });

  it('refuses a negative charge', async () => {
    expect((await post(charge({ amountCents: -100 }))).status).toBe(400);
  });
});

describe('the money itself', () => {
  it('refuses a blank amount rather than treating it as zero', async () => {
    // The whole reason the blank-first rule exists: `Number('')` is 0, and a
    // zero-cent charge posted because a field was empty is a fact nobody
    // recorded.
    for (const amountCents of ['', null, undefined]) {
      const res = await post(charge({ amountCents }));
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/required/i);
    }
    expect(await entries()).toHaveLength(0);
  });

  it('refuses an explicit zero', async () => {
    const res = await post(charge({ amountCents: 0 }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/cannot be zero/i);
  });

  it('refuses an amount too large to be integer cents', async () => {
    // `Number.isInteger(1e21)` is TRUE, and 1e21 is past SQLite's 64-bit
    // INTEGER range, so it would land in the column as a REAL — a float in the
    // one table whose premise is whole cents. Below that, the cap is a typo
    // guard: a slipped keyboard should not post a million-dollar charge.
    for (const amountCents of [1e21, Number.MAX_SAFE_INTEGER, 100_000_001]) {
      const res = await post(charge({ amountCents }));
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/decimal point|larger than/i);
    }
    // And the same bound applies to a credit, not only to a charge.
    const credit = await post({
      action: 'postAdjustment',
      lotId: 'lot-a',
      amountCents: -1e21,
      effectiveDay: '2026-03-01',
      description: 'Waiver',
      operationKey: nextKey(),
    });
    expect(credit.status).toBe(400);
    expect(await entries()).toHaveLength(0);
  });

  it('accepts the largest entry it allows', async () => {
    const res = await post(charge({ amountCents: 100_000_000 }));
    expect(res.status).toBe(201);
    const [row] = await entries();
    expect(row.amountCents).toBe(100_000_000);
    expect(Number.isInteger(row.amountCents)).toBe(true);
  });

  it('refuses a fraction of a cent, and a numeric string', async () => {
    expect((await post(charge({ amountCents: 450.5 }))).status).toBe(400);
    expect((await post(charge({ amountCents: '45000' }))).status).toBe(400);
    expect(await entries()).toHaveLength(0);
  });
});

describe('posting a payment', () => {
  it('takes a positive amount and stores it as a credit', async () => {
    const res = await post({
      action: 'postPayment',
      lotId: 'lot-a',
      method: 'check',
      amountCents: 45000,
      effectiveDay: '2026-02-01',
      description: 'Check 1041',
      reference: 'check 1041',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(201);

    const [row] = await entries();
    expect(row.kind).toBe('payment');
    expect(row.amountCents).toBe(-45000);
    expect(row.method).toBe('check');
    expect(row.reference).toBe('check 1041');
  });

  it('refuses an online payment entered by hand', async () => {
    // An online payment exists because a verified provider event said so.
    // Hand-entering one would put a row in the ledger that reconciliation
    // will never match.
    const res = await post({
      action: 'postPayment',
      lotId: 'lot-a',
      method: 'online',
      amountCents: 45000,
      effectiveDay: '2026-02-01',
      description: 'Paid online',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/from the provider/i);
  });

  it('refuses a negative payment, which would be a charge in disguise', async () => {
    const res = await post({
      action: 'postPayment',
      lotId: 'lot-a',
      method: 'check',
      amountCents: -45000,
      effectiveDay: '2026-02-01',
      description: 'Check 1041',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(400);
  });
});

describe('posting an adjustment', () => {
  it('takes the sign the board chose, either way', async () => {
    expect(
      (
        await post({
          action: 'postAdjustment',
          lotId: 'lot-a',
          amountCents: -5000,
          effectiveDay: '2026-03-01',
          description: 'Board-approved waiver',
          operationKey: nextKey(),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post({
          action: 'postAdjustment',
          lotId: 'lot-a',
          amountCents: 2500,
          effectiveDay: '2026-03-02',
          description: 'Correction',
          operationKey: nextKey(),
        })
      ).status,
    ).toBe(201);

    const rows = await entries();
    expect(rows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([
      -5000, 2500,
    ]);
  });
});

describe('reversing an entry', () => {
  async function postedCharge() {
    const res = await post(charge());
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  it('writes the exact negation, on the same lot', async () => {
    const id = await postedCharge();
    const res = await post({
      action: 'reverse',
      entryId: id,
      effectiveDay: '2026-04-01',
      description: 'Posted to the wrong lot',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(201);

    const rows = await entries();
    const reversal = rows.find((r) => r.kind === 'reversal');
    expect(reversal?.amountCents).toBe(-45000);
    expect(reversal?.lotId).toBe('lot-a');
    expect(reversal?.reversesEntryId).toBe(id);
    // And the balance is back to nothing, which is the point.
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(0);
  });

  it('refuses to reverse a reversal', async () => {
    const id = await postedCharge();
    const first = await post({
      action: 'reverse',
      entryId: id,
      effectiveDay: '2026-04-01',
      description: 'Reversal',
      operationKey: nextKey(),
    });
    const { id: reversalId } = (await first.json()) as { id: string };

    const res = await post({
      action: 'reverse',
      entryId: reversalId,
      effectiveDay: '2026-04-02',
      description: 'Un-reversing',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(409);
    expect((await entries()).filter((r) => r.kind === 'reversal')).toHaveLength(
      1,
    );
  });

  it('refuses a second reversal of the same entry', async () => {
    const id = await postedCharge();
    await post({
      action: 'reverse',
      entryId: id,
      effectiveDay: '2026-04-01',
      description: 'Reversal',
      operationKey: nextKey(),
    });
    const res = await post({
      action: 'reverse',
      entryId: id,
      effectiveDay: '2026-04-02',
      description: 'Again',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(409);
  });

  it('refuses an unknown entry', async () => {
    const res = await post({
      action: 'reverse',
      entryId: 'no-such-entry',
      effectiveDay: '2026-04-01',
      description: 'Reversal',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(409);
    expect(await entries()).toHaveLength(0);
  });
});

describe('a double submit', () => {
  it('posts nothing twice', async () => {
    const body = charge();
    expect((await post(body)).status).toBe(201);
    const second = await post(body);
    expect(second.status).toBe(409);
    expect(await second.text()).toMatch(/already posted/i);
    expect(await entries()).toHaveLength(1);
  });

  it('is refused before anything is written, not after', async () => {
    const body = charge();
    await post(body);
    await post(body);
    expect(await getDb(env).select().from(lotRecordEvents)).toHaveLength(1);
  });

  it('requires an operation key at all', async () => {
    const { operationKey: _omitted, ...withoutKey } = charge();
    const res = await post(withoutKey);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/operationKey is required/);
  });
});

describe('a bulk assessment', () => {
  it('posts one charge to every non-retired lot under one key', async () => {
    await seedProperty('lot-retired', { retiredAt: new Date('2026-01-01') });

    const res = await post({
      action: 'postBulkAssessment',
      category: 'assessment',
      amountCents: 45000,
      effectiveDay: '2026-01-01',
      description: 'Q1 assessment',
      operationKey: 'bulk-q1',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ posted: 2 });

    const rows = await entries();
    expect(rows.map((r) => r.lotId).sort()).toEqual(['lot-a', 'lot-b']);
    expect(new Set(rows.map((r) => r.operationKey))).toEqual(
      new Set(['bulk-q1']),
    );
  });

  it('posts nothing twice on a re-submission', async () => {
    const body = {
      action: 'postBulkAssessment',
      category: 'assessment',
      amountCents: 45000,
      effectiveDay: '2026-01-01',
      description: 'Q1 assessment',
      operationKey: 'bulk-q1',
    };
    expect((await post(body)).status).toBe(201);
    const second = await post(body);
    expect(second.status).toBe(409);
    expect(await entries()).toHaveLength(2);
  });

  it('refuses a blank or zero amount like any other entry', async () => {
    for (const amountCents of [0, '', 45.5]) {
      const res = await post({
        action: 'postBulkAssessment',
        category: 'assessment',
        amountCents,
        effectiveDay: '2026-01-01',
        description: 'Q1 assessment',
        operationKey: nextKey(),
      });
      expect(res.status).toBe(400);
    }
    expect(await entries()).toHaveLength(0);
  });
});

describe('the board read', () => {
  it('returns the ledger, and narrows to one lot', async () => {
    await post(charge());
    await post(charge({ lotId: 'lot-b', description: 'Q1 for lot B' }));

    const all = (await (await get()).json()) as { lotId: string }[];
    expect(all).toHaveLength(2);

    const oneLot = (await (await get('?lotId=lot-b')).json()) as {
      lotId: string;
    }[];
    expect(oneLot.map((e) => e.lotId)).toEqual(['lot-b']);
  });
});

describe('unknown actions', () => {
  it('are refused with 400, naming the ones that exist', async () => {
    const res = await post({ action: 'deleteEverything' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('postCharge');
  });
});

describe('what the reversal takes from the original', () => {
  it('reverses a payment into a charge-shaped credit reversal', async () => {
    // Every other reversal test starts from a charge, so an implementation
    // writing `-abs(amount)` would pass them all — and on a payment it would
    // DOUBLE the credit instead of undoing it.
    const paid = await post({
      action: 'postPayment',
      lotId: 'lot-a',
      method: 'check',
      amountCents: 45000,
      effectiveDay: '2026-02-01',
      description: 'Check 1041',
      operationKey: nextKey(),
    });
    const { id } = (await paid.json()) as { id: string };

    const res = await post({
      action: 'reverse',
      entryId: id,
      effectiveDay: '2026-02-10',
      description: 'Check returned',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(201);

    const rows = await entries();
    const reversal = rows.find((r) => r.kind === 'reversal');
    expect(reversal?.amountCents).toBe(45000);
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(0);
  });

  it('takes the lot from the original, not from the body', async () => {
    const posted = await post(charge({ lotId: 'lot-b' }));
    const { id } = (await posted.json()) as { id: string };

    await post({
      action: 'reverse',
      entryId: id,
      lotId: 'lot-a',
      effectiveDay: '2026-04-01',
      description: 'Reversal',
      operationKey: nextKey(),
    });

    const reversal = (await entries()).find((r) => r.kind === 'reversal');
    expect(reversal?.lotId).toBe('lot-b');
  });

  it('refuses to reverse a provider-sourced entry', async () => {
    // The provider's own funds_withdrawn path needs the single
    // reverses_entry_id slot; a board reversal would occupy it and leave a
    // real ACH return with nowhere to write its effect.
    await getDb(env)
      .insert(duesLedgerEntries)
      .values({
        id: 'provider-1',
        lotId: 'lot-a',
        kind: 'payment',
        amountCents: -45000,
        effectiveDay: '2026-02-01',
        description: 'Online payment',
        category: null,
        method: 'online',
        reference: null,
        source: 'provider',
        paymentId: 'pay_1',
        reversesEntryId: null,
        recordedBy: null,
        recordedAt: new Date('2026-02-01T12:00:00Z'),
        operationKey: 'provider-op',
      });

    const res = await post({
      action: 'reverse',
      entryId: 'provider-1',
      effectiveDay: '2026-02-10',
      description: 'Undo',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/payment provider/i);
    expect((await entries()).filter((r) => r.kind === 'reversal')).toHaveLength(
      0,
    );
  });
});

describe('a reused operation key', () => {
  it('is not reported as "already posted" when it names a different entry', async () => {
    // The costly confusion: a key reused from a stale tab for a DIFFERENT
    // charge must not be answered as though that charge had already been
    // recorded. Nothing like it exists anywhere, and the board would be
    // reassured while the money went unrecorded.
    await post(charge({ operationKey: 'shared-key', amountCents: 45000 }));

    const res = await post(
      charge({ operationKey: 'shared-key', amountCents: 99900 }),
    );
    expect(res.status).toBe(409);
    const message = await res.text();
    expect(message).toMatch(/different entry/i);
    expect(message).not.toMatch(/already posted/i);
    expect(await entries()).toHaveLength(1);
  });

  it('is reported as an idempotent retry when it names the same entry', async () => {
    const body = charge({ operationKey: 'shared-key' });
    await post(body);
    const res = await post(body);
    expect(await res.text()).toMatch(/already posted/i);
  });

  it('names the reversal rule when that is what collided', async () => {
    const posted = await post(charge());
    const { id } = (await posted.json()) as { id: string };
    await post({
      action: 'reverse',
      entryId: id,
      effectiveDay: '2026-04-01',
      description: 'Reversal',
      operationKey: nextKey(),
    });

    const res = await post({
      action: 'reverse',
      entryId: id,
      effectiveDay: '2026-04-02',
      description: 'Again, with a fresh key',
      operationKey: nextKey(),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already been reversed/i);
    expect((await entries()).filter((r) => r.kind === 'reversal')).toHaveLength(
      1,
    );
  });
});

describe('the bulk assessment and the event log', () => {
  it('logs one created event per entry, as ADR 0024 asks', async () => {
    const res = await post({
      action: 'postBulkAssessment',
      category: 'assessment',
      amountCents: 45000,
      effectiveDay: '2026-01-01',
      description: 'Q1 assessment',
      operationKey: 'bulk-q1',
    });
    expect(res.status).toBe(201);

    const events = await getDb(env).select().from(lotRecordEvents);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.recordType))).toEqual(
      new Set(['dues_ledger_entries']),
    );
    const ids = (await entries()).map((e) => e.id).sort();
    expect(events.map((e) => e.recordId).sort()).toEqual(ids);
  });

  it('reaches a lot created after the first post, and logs only that one', async () => {
    const body = {
      action: 'postBulkAssessment',
      category: 'assessment',
      amountCents: 45000,
      effectiveDay: '2026-01-01',
      description: 'Q1 assessment',
      operationKey: 'bulk-q1',
    };
    await post(body);
    await seedProperty('lot-c');

    const second = await post(body);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ posted: 1 });

    const rows = await entries();
    expect(rows.map((r) => r.lotId).sort()).toEqual([
      'lot-a',
      'lot-b',
      'lot-c',
    ]);
    expect(await getDb(env).select().from(lotRecordEvents)).toHaveLength(3);
  });

  it('refuses when every active lot already has it', async () => {
    const body = {
      action: 'postBulkAssessment',
      category: 'assessment',
      amountCents: 45000,
      effectiveDay: '2026-01-01',
      description: 'Q1 assessment',
      operationKey: 'bulk-q1',
    };
    await post(body);
    const second = await post(body);
    expect(second.status).toBe(409);
    expect(await entries()).toHaveLength(2);
  });
});

describe('the fields every entry needs', () => {
  it('refuses a missing lot, day, or description on each entry action', async () => {
    // Each action carries its own copy of these checks, so a dropped copy is
    // silent — they are asserted per action rather than once.
    const bodies = [
      charge({ lotId: '' }),
      charge({ effectiveDay: '' }),
      charge({ description: '' }),
      {
        action: 'postPayment',
        lotId: '',
        method: 'check',
        amountCents: 100,
        effectiveDay: '2026-01-01',
        description: 'x',
        operationKey: nextKey(),
      },
      {
        action: 'postAdjustment',
        lotId: 'lot-a',
        amountCents: 100,
        effectiveDay: '',
        description: 'x',
        operationKey: nextKey(),
      },
      {
        action: 'reverse',
        entryId: 'whatever',
        effectiveDay: '2026-01-01',
        description: '',
        operationKey: nextKey(),
      },
      {
        action: 'postBulkAssessment',
        category: 'assessment',
        amountCents: 100,
        effectiveDay: '',
        description: 'x',
        operationKey: nextKey(),
      },
    ];
    for (const body of bodies) expect((await post(body)).status).toBe(400);
    expect(await entries()).toHaveLength(0);
  });

  it('refuses a day that is not a real calendar date, on every action', async () => {
    for (const effectiveDay of ['2026-13-01', '2026-02-30', 'zzzz-99-99']) {
      expect((await post(charge({ effectiveDay }))).status).toBe(400);
      expect(
        (
          await post({
            action: 'postBulkAssessment',
            category: 'assessment',
            amountCents: 100,
            effectiveDay,
            description: 'x',
            operationKey: nextKey(),
          })
        ).status,
      ).toBe(400);
    }
    expect(await entries()).toHaveLength(0);
  });

  it('refuses an unknown or missing payment method', async () => {
    for (const method of ['venmo', '', undefined]) {
      const res = await post({
        action: 'postPayment',
        lotId: 'lot-a',
        method,
        amountCents: 100,
        effectiveDay: '2026-01-01',
        description: 'x',
        operationKey: nextKey(),
      });
      expect(res.status).toBe(400);
    }
  });

  it('answers 400 to a malformed JSON body rather than 500', async () => {
    const res = (await POST({
      request: new Request('http://localhost/api/admin/dues-ledger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
      locals: { authContext: board },
    } as never)) as Response;
    expect(res.status).toBe(400);
  });
});

describe('one entry history', () => {
  it('reads the events for a single entry, and refuses an empty id', async () => {
    const posted = await post(charge());
    const { id } = (await posted.json()) as { id: string };

    const events = (await (await get(`?events=${id}`)).json()) as {
      action: string;
    }[];
    expect(events.map((e) => e.action)).toEqual(['created']);

    expect((await get('?events=')).status).toBe(400);
  });
});
