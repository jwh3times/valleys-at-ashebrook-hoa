import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/dues-ledger';
import { getDb } from '../../src/server/db/client';
import {
  duesLedgerEntries,
  lotRecordEvents,
  settings,
} from '../../src/server/db/schema';
import { legacyAuthContext } from '../../src/server/authz/context';
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

const board = legacyAuthContext('board-1', 'board', []);
const homeowner = legacyAuthContext('owner-1', 'homeowner', ['lot-a']);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

let keySequence = 0;
const nextKey = () => `op-${++keySequence}`;

function post(
  body: Record<string, unknown>,
  ctx: ReturnType<typeof legacyAuthContext> | null = board,
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

function get(
  query = '',
  ctx: ReturnType<typeof legacyAuthContext> | null = board,
) {
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
