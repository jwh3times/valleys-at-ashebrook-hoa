import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as lotRecords from '../../src/server/lot-records/reads';
import { getDb } from '../../src/server/db/client';
import { duesLedgerEntries } from '../../src/server/db/schema';
import {
  parties,
  people,
  organizations,
  ownerships,
  representations,
  representationLots,
} from '../../src/server/db/roster-schema';
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
  // The ledger is cleared by `truncateAll`, which nulls a reversal's
  // self-reference first — deleting the table here instead would hit the
  // RESTRICT on the entry a reversal points at.
  await db.delete(representationLots);
  await db.delete(representations);
  await db.delete(organizations);
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

    const [entry] = await lotRecords.fetchAdminLotDuesLedger(env);
    expect(entry.reference).toBe('check 1041');
    expect(entry.source).toBe('board');
    expect(entry.recordedBy).toBe('board-1');
    expect(entry.operationKey).toBe('op-1');
  });

  it('returns every lot, oldest first, with a stable order within a day', async () => {
    // Same day, same recorded_at: without the id tiebreak the running order of
    // a statement of account changes between reads.
    await seedEntry('lot-b', 'charge', 20000, '2026-03-01');
    await seedEntry('lot-a', 'charge', 10000, '2026-01-01');
    await seedEntry('lot-a', 'payment', -5000, '2026-01-01');

    const first = await lotRecords.fetchAdminLotDuesLedger(env);
    const second = await lotRecords.fetchAdminLotDuesLedger(env);
    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
    expect(first.map((e) => e.effectiveDay)).toEqual([
      '2026-01-01',
      '2026-01-01',
      '2026-03-01',
    ]);
    expect(first[0].recordedAt).toBeInstanceOf(Date);
  });

  it('narrows to one lot when asked', async () => {
    await seedEntry('lot-a', 'charge', 10000, '2026-02-01');
    await seedEntry('lot-b', 'charge', 20000, '2026-02-01');

    const entries = await lotRecords.fetchAdminLotDuesLedger(env, 'lot-b');
    expect(entries.map((e) => e.lotId)).toEqual(['lot-b']);
  });
});

describe('the constraints the money rests on', () => {
  // The CHECKs are the only statement of these rules — the write path does not
  // exist yet — so they are exercised here rather than trusted. Each insert
  // goes through Drizzle exactly as a route would.
  const base = {
    id: 'x1',
    lotId: 'lot-a',
    effectiveDay: '2026-09-01',
    description: 'Probe',
    reference: null,
    paymentId: null,
    reversesEntryId: null,
    recordedBy: 'board-1',
    recordedAt: new Date('2026-09-01T12:00:00Z'),
    operationKey: 'probe-key',
  };
  const insert = (values: Record<string, unknown>) =>
    getDb(env)
      .insert(duesLedgerEntries)
      .values({ ...base, ...values } as never);

  it('refuses a charge that is not positive', async () => {
    await expect(
      insert({
        kind: 'charge',
        amountCents: -500,
        category: 'assessment',
        source: 'board',
      }),
    ).rejects.toThrow();
  });

  it('refuses a payment that is not negative', async () => {
    await expect(
      insert({
        kind: 'payment',
        amountCents: 500,
        method: 'check',
        source: 'board',
      }),
    ).rejects.toThrow();
  });

  it('refuses an adjustment of zero', async () => {
    await expect(
      insert({ kind: 'adjustment', amountCents: 0, source: 'board' }),
    ).rejects.toThrow();
  });

  it('refuses a charge with no category, and a payment with no method', async () => {
    await expect(
      insert({ kind: 'charge', amountCents: 500, source: 'board' }),
    ).rejects.toThrow();
    await expect(
      insert({ kind: 'payment', amountCents: -500, source: 'board' }),
    ).rejects.toThrow();
  });

  it('refuses a category on a payment, and a method on a charge', async () => {
    await expect(
      insert({
        kind: 'payment',
        amountCents: -500,
        method: 'check',
        category: 'assessment',
        source: 'board',
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        kind: 'charge',
        amountCents: 500,
        category: 'assessment',
        method: 'check',
        source: 'board',
      }),
    ).rejects.toThrow();
  });

  it('refuses a provider row that names an actor, and a board row that does not', async () => {
    await expect(
      insert({
        kind: 'payment',
        amountCents: -500,
        method: 'online',
        source: 'provider',
        paymentId: 'pay_1',
        recordedBy: 'board-1',
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        kind: 'payment',
        amountCents: -500,
        method: 'check',
        source: 'board',
        recordedBy: null,
      }),
    ).rejects.toThrow();
  });

  it('refuses a provider CHARGE, which no verified event can produce', async () => {
    // The row shape a homeowner disputing a charge could never have traced:
    // no accountable account, and no payment behind it.
    await expect(
      insert({
        kind: 'charge',
        amountCents: 500,
        category: 'assessment',
        source: 'provider',
        recordedBy: null,
      }),
    ).rejects.toThrow();
  });

  it('refuses a payment id on a board-entered row', async () => {
    await expect(
      insert({
        kind: 'payment',
        amountCents: -500,
        method: 'check',
        source: 'board',
        paymentId: 'pay_1',
      }),
    ).rejects.toThrow();
  });

  it('refuses a reverses-link on a non-reversal, and a reversal without one', async () => {
    const original = await seedEntry('lot-a', 'charge', 500, '2026-01-01');
    await expect(
      insert({
        kind: 'charge',
        amountCents: 500,
        category: 'assessment',
        source: 'board',
        reversesEntryId: original,
      }),
    ).rejects.toThrow();
    await expect(
      insert({ kind: 'reversal', amountCents: -500, source: 'board' }),
    ).rejects.toThrow();
  });

  it('refuses a second reversal of the same entry', async () => {
    const original = await seedEntry('lot-a', 'charge', 500, '2026-01-01');
    await insert({
      id: 'rev-1',
      kind: 'reversal',
      amountCents: -500,
      source: 'board',
      reversesEntryId: original,
      operationKey: 'rev-1-key',
    });
    await expect(
      insert({
        id: 'rev-2',
        kind: 'reversal',
        amountCents: -500,
        source: 'board',
        reversesEntryId: original,
        operationKey: 'rev-2-key',
      }),
    ).rejects.toThrow();
  });

  it('refuses the same operation key twice on one lot, and allows it across lots', async () => {
    // ADR 0025's bulk post writes one row per lot under ONE key, so the key
    // alone cannot be unique — but a re-submission must still post nothing.
    await insert({
      id: 'bulk-a',
      kind: 'charge',
      amountCents: 500,
      category: 'assessment',
      source: 'board',
      operationKey: 'bulk-q1',
    });
    await insert({
      id: 'bulk-b',
      lotId: 'lot-b',
      kind: 'charge',
      amountCents: 500,
      category: 'assessment',
      source: 'board',
      operationKey: 'bulk-q1',
    });
    await expect(
      insert({
        id: 'bulk-again',
        kind: 'charge',
        amountCents: 500,
        category: 'assessment',
        source: 'board',
        operationKey: 'bulk-q1',
      }),
    ).rejects.toThrow();
  });

  it('refuses a second credited entry for one provider payment', async () => {
    await insert({
      id: 'prov-1',
      kind: 'payment',
      amountCents: -500,
      method: 'online',
      source: 'provider',
      recordedBy: null,
      paymentId: 'pay_9',
      operationKey: 'prov-1-key',
    });
    await expect(
      insert({
        id: 'prov-2',
        kind: 'payment',
        amountCents: -500,
        method: 'online',
        source: 'provider',
        recordedBy: null,
        paymentId: 'pay_9',
        operationKey: 'prov-2-key',
      }),
    ).rejects.toThrow();
  });

  it('refuses a malformed effective day and a blank description', async () => {
    await expect(
      insert({
        kind: 'charge',
        amountCents: 500,
        category: 'assessment',
        source: 'board',
        effectiveDay: 'zzzz-99-99',
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        kind: 'charge',
        amountCents: 500,
        category: 'assessment',
        source: 'board',
        description: '   ',
      }),
    ).rejects.toThrow();
  });
});

describe('a reversal in the ledger', () => {
  it('is itemized and summed like any other entry', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    const original = await seedEntry('lot-a', 'charge', 50000, '2026-02-01');
    await getDb(env)
      .insert(duesLedgerEntries)
      .values({
        id: 'rev-1',
        lotId: 'lot-a',
        kind: 'reversal',
        amountCents: -50000,
        effectiveDay: '2026-03-01',
        description: 'Reverses the February assessment',
        category: null,
        method: null,
        reference: null,
        source: 'board',
        paymentId: null,
        reversesEntryId: original,
        recordedBy: 'board-1',
        recordedAt: new Date('2026-03-01T12:00:00Z'),
        operationKey: 'rev-op',
      });

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'person-1', DAY);
    expect(lot.entries.map((e) => e.kind)).toEqual(['charge', 'reversal']);
    expect(lot.balanceCents).toBe(0);
  });

  it('collapses into the opening figure when it predates the reader', async () => {
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    const original = await seedEntry('lot-a', 'charge', 50000, '2026-02-01');
    await getDb(env)
      .insert(duesLedgerEntries)
      .values({
        id: 'rev-1',
        lotId: 'lot-a',
        kind: 'reversal',
        amountCents: -50000,
        effectiveDay: '2026-03-01',
        description: 'Reverses the February assessment',
        category: null,
        method: null,
        reference: null,
        source: 'board',
        paymentId: null,
        reversesEntryId: original,
        recordedBy: 'board-1',
        recordedAt: new Date('2026-03-01T12:00:00Z'),
        operationKey: 'rev-op',
      });

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'buyer', DAY);
    expect(lot.openingBalanceCents).toBe(0);
    expect(lot.entries).toEqual([]);
  });
});

describe("an organization's representative", () => {
  it('splits at the later of the representation and the ownership start', async () => {
    // The only branch where the two predicates differ is the MAX in the
    // Representation arm, so it is the one most likely to drift: the
    // organization has owned the lot since January, this person has
    // represented it only since June, and their period starts in June.
    const now = new Date('2026-01-01T00:00:00Z');
    const db = getDb(env);
    await db.insert(parties).values({
      id: 'org-1',
      kind: 'organization',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organizations).values({
      partyId: 'org-1',
      partyKind: 'organization',
      legalName: 'Ashebrook Holdings LLC',
      nameNormalized: 'ashebrook holdings llc',
      updatedAt: now,
    });
    await db
      .insert(parties)
      .values({ id: 'rep-1', kind: 'person', createdAt: now, updatedAt: now });
    await db.insert(people).values({
      partyId: 'rep-1',
      fullName: 'Person rep-1',
      nameNormalized: 'person rep-1',
      updatedAt: now,
    });
    await db.insert(ownerships).values({
      id: 'org-1-lot-a',
      ownerPartyId: 'org-1',
      lotId: 'lot-a',
      startDay: '2026-01-01',
      endDay: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(representations).values({
      id: 'rep-1-org-1',
      organizationPartyId: 'org-1',
      representativePersonId: 'rep-1',
      scopeKind: 'organization',
      startDay: '2026-06-01',
      endDay: null,
      createdAt: now,
      updatedAt: now,
    });
    await seedEntry('lot-a', 'charge', 10000, '2026-03-01');
    await seedEntry('lot-a', 'charge', 20000, '2026-07-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'rep-1', DAY);
    expect(lot.openingBalanceCents).toBe(10000);
    expect(lot.entries.map((e) => e.amountCents)).toEqual([20000]);
    expect(lot.balanceCents).toBe(30000);
  });
});

describe('the boundary between the two halves', () => {
  it('itemizes an entry dated exactly on the first day of the period', async () => {
    // The off-by-one that moves a row from the opening figure into the list.
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'charge', 10000, '2026-05-31');
    await seedEntry('lot-a', 'charge', 20000, '2026-06-01');

    const [lot] = await lotRecords.fetchMemberDuesLedger(env, 'buyer', DAY);
    expect(lot.openingBalanceCents).toBe(10000);
    expect(lot.entries.map((e) => e.amountCents)).toEqual([20000]);
    expect(lot.balanceCents).toBe(30000);
  });

  it('gives one lot an opening figure and the other none, in one read', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-06-01' });
    await seedLotAuthority('person-1', 'lot-b', { startDay: '2020-01-01' });
    await seedEntry('lot-a', 'charge', 10000, '2026-01-01');
    await seedEntry('lot-a', 'charge', 20000, '2026-07-01');
    await seedEntry('lot-b', 'charge', 30000, '2026-07-01');

    const [a, b] = await lotRecords.fetchMemberDuesLedger(env, 'person-1', DAY);
    expect([a.openingBalanceCents, a.entries.length, a.balanceCents]).toEqual([
      10000, 1, 30000,
    ]);
    expect([b.openingBalanceCents, b.entries.length, b.balanceCents]).toEqual([
      0, 1, 30000,
    ]);
  });
});
