import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as lotRecords from '../../src/server/lot-records/reads';
import { getDb } from '../../src/server/db/client';
import { duesLedgerEntries } from '../../src/server/db/schema';
import { parties } from '../../src/server/db/roster-schema';
import {
  truncateAll,
  seedProperty,
  seedLotAuthority,
  seedPerson,
} from './fixtures';

/**
 * The dues ledger (ADR 0025, #295 slice 1), and the rule that makes it
 * different from every other Lot Record read.
 *
 * A violation from before the reader's period is simply omitted. A ledger
 * entry cannot be: the balance is the sum of everything ever posted to the
 * Lot, so dropping the earlier entries would show a partial balance — a
 * homeowner reading "you owe $40" when the Lot owes $1,240. ADR 0024 fixes the
 * answer: the figure stays whole, and the earlier entries collapse into one
 * opening line rather than disappearing.
 *
 * That is what most of this suite is about. The rest is the arithmetic being
 * exact — integer cents, signs fixed by kind — because this is the first
 * number on the site a homeowner can check against their own bank statement.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const DAY = '2026-09-20';

let sequence = 0;

async function seedEntry(
  lotId: string,
  kind: 'charge' | 'payment' | 'adjustment',
  amountCents: number,
  effectiveDay: string,
  overrides: { description?: string; reference?: string | null } = {},
) {
  sequence += 1;
  await getDb(env)
    .insert(duesLedgerEntries)
    .values({
      id: `e${sequence}`,
      lotId,
      kind,
      amountCents,
      effectiveDay,
      description: overrides.description ?? `Entry ${sequence}`,
      category: kind === 'charge' ? 'assessment' : null,
      method: kind === 'payment' ? 'check' : null,
      reference: overrides.reference ?? null,
      source: 'board',
      paymentId: null,
      reversesEntryId: null,
      recordedBy: 'board-1',
      recordedAt: new Date(`2026-01-01T00:00:0${sequence % 10}Z`),
      operationKey: `op-${sequence}`,
    });
  return `e${sequence}`;
}

beforeEach(async () => {
  sequence = 0;
  const db = getDb(env);
  await db.delete(duesLedgerEntries);
  await db.update(parties).set({ consolidatedIntoPartyId: null });
  await truncateAll();
  await seedProperty('lot-a');
  await seedProperty('lot-b');
});

describe('the balance stays whole', () => {
  it('collapses everything before the reader period into one opening figure', async () => {
    // The seller's period: a 1,200.00 assessment and an 800.00 payment, so the
    // lot carried 400.00 into the sale.
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'charge', 120000, '2026-01-01');
    await seedEntry('lot-a', 'payment', -80000, '2026-02-01');
    // The buyer's own period.
    await seedEntry('lot-a', 'charge', 30000, '2026-07-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'buyer', DAY);
    expect(lot.openingBalanceCents).toBe(40000);
    expect(lot.entries.map((e) => e.amountCents)).toEqual([30000]);
    expect(lot.balanceCents).toBe(70000);
  });

  it("never itemizes the earlier owner's entries", async () => {
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'payment', -80000, '2026-02-01', {
      description: 'Check 1041 from the seller',
    });
    await seedEntry('lot-a', 'charge', 30000, '2026-07-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'buyer', DAY);
    expect(JSON.stringify(lot)).not.toContain('Check 1041');
    expect(lot.entries).toHaveLength(1);
  });

  it('reports a zero opening balance as zero, not as a missing line', async () => {
    // A lot whose earlier entries happen to net to nothing is not the same as
    // a lot with no earlier entries, but the reader sees the same figure.
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'charge', 50000, '2026-01-01');
    await seedEntry('lot-a', 'payment', -50000, '2026-02-01');
    await seedEntry('lot-a', 'charge', 30000, '2026-07-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'buyer', DAY);
    expect(lot.openingBalanceCents).toBe(0);
    expect(lot.balanceCents).toBe(30000);
  });

  it('still reports the balance when every entry predates the reader', async () => {
    // Nothing to itemize, but the lot still owes what it owes.
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'charge', 120000, '2026-01-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'buyer', DAY);
    expect(lot.entries).toEqual([]);
    expect(lot.openingBalanceCents).toBe(120000);
    expect(lot.balanceCents).toBe(120000);
    expect(lot.openingBeforeDay).toBeNull();
  });

  it('itemizes everything when the ownership start is unknown', async () => {
    // A NULL start_day is legacy history: the start is unknown rather than
    // recent, so there is nothing to collapse.
    await seedLotAuthority('legacy-owner', 'lot-a', { startDay: null });
    await seedEntry('lot-a', 'charge', 120000, '2019-01-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(
      env,
      'legacy-owner',
      DAY,
    );
    expect(lot.openingBalanceCents).toBe(0);
    expect(lot.entries).toHaveLength(1);
    expect(lot.balanceCents).toBe(120000);
  });
});

describe('the arithmetic', () => {
  it('sums in integer cents, with signs fixed by kind', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 120000, '2026-01-01');
    await seedEntry('lot-a', 'payment', -45050, '2026-02-01');
    await seedEntry('lot-a', 'adjustment', -1000, '2026-03-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'person-1', DAY);
    expect(lot.balanceCents).toBe(73950);
  });

  it('reads a credit balance as a negative number', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 10000, '2026-01-01');
    await seedEntry('lot-a', 'payment', -15000, '2026-02-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'person-1', DAY);
    expect(lot.balanceCents).toBe(-5000);
  });

  it('orders entries oldest first, the way a statement reads', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 10000, '2026-03-01');
    await seedEntry('lot-a', 'charge', 20000, '2026-01-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'person-1', DAY);
    expect(lot.entries.map((e) => e.effectiveDay)).toEqual([
      '2026-01-01',
      '2026-03-01',
    ]);
  });
});

describe('the audience', () => {
  it("never reads another lot's entries, nor sums them into a balance", async () => {
    // The sharper half: a lot the caller does not hold must be absent from the
    // ITEMS and from the opening figure. Summing it would leak the other
    // lot's balance without showing a single row.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'charge', 10000, '2026-07-01');
    await seedEntry('lot-b', 'charge', 999999, '2026-01-01');
    await seedEntry('lot-b', 'charge', 999999, '2026-07-01');

    const ledgers = await lotRecords.fetchMemberDuesLedger(
      env,
      'person-1',
      DAY,
    );
    expect(ledgers.map((l) => l.lotId)).toEqual(['lot-a']);
    expect(ledgers[0].balanceCents).toBe(10000);
  });

  it('gives a former owner nothing, not even a balance', async () => {
    await seedLotAuthority('seller', 'lot-a', {
      startDay: '2020-01-01',
      endDay: '2026-06-01',
    });
    await seedEntry('lot-a', 'charge', 120000, '2021-01-01');

    expect(await lotRecords.fetchMemberDuesLedger(env, 'seller', DAY)).toEqual(
      [],
    );
  });

  it('gives an unlinked account nothing', async () => {
    await seedEntry('lot-a', 'charge', 120000, '2026-01-01');
    expect(await lotRecords.fetchMemberDuesLedger(env, null, DAY)).toEqual([]);
  });

  it('reads through a consolidated duplicate link', async () => {
    await seedLotAuthority('survivor', 'lot-a', { startDay: '2026-01-01' });
    await seedPerson('duplicate', {
      fullName: 'Person duplicate',
      nameNormalized: 'person duplicate',
    });
    await getDb(env)
      .update(parties)
      .set({ consolidatedIntoPartyId: 'survivor' })
      .where(eq(parties.id, 'duplicate'));
    await seedEntry('lot-a', 'charge', 120000, '2026-02-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'duplicate', DAY);
    expect(lot?.balanceCents).toBe(120000);
  });

  it('gives each of two lots its own ledger', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedLotAuthority('person-1', 'lot-b', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 10000, '2026-02-01');
    await seedEntry('lot-b', 'charge', 20000, '2026-02-01');

    const ledgers = await lotRecords.fetchMemberDuesLedger(
      env,
      'person-1',
      DAY,
    );
    expect(ledgers.map((l) => [l.lotId, l.balanceCents])).toEqual([
      ['lot-a', 10000],
      ['lot-b', 20000],
    ]);
  });

  it('never carries the board-only reference', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'payment', -10000, '2026-02-01', {
      reference: 'check 1041',
    });

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'person-1', DAY);
    expect(JSON.stringify(lot)).not.toContain('check 1041');
    expect(lot.entries[0]).not.toHaveProperty('reference');
  });
});

describe('the board read', () => {
  it('returns every column, including the board-only reference', async () => {
    await seedEntry('lot-a', 'payment', -10000, '2026-02-01', {
      reference: 'check 1041',
    });

    const [entry] = await lotRecords.fetchAdminDuesLedger(env);
    expect(entry.reference).toBe('check 1041');
    expect(entry.source).toBe('board');
    expect(entry.recordedBy).toBe('board-1');
    expect(entry.operationKey).toBe('op-1');
  });

  it('narrows to one lot when asked', async () => {
    await seedEntry('lot-a', 'charge', 10000, '2026-02-01');
    await seedEntry('lot-b', 'charge', 20000, '2026-02-01');

    const entries = await lotRecords.fetchAdminDuesLedger(env, 'lot-b');
    expect(entries.map((e) => e.lotId)).toEqual(['lot-b']);
  });
});
