import { env, applyD1Migrations } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  elections,
  electionEligibility,
  candidates,
  ballots,
  properties,
} from '../../src/server/db/schema';
import {
  fetchElectionsFor,
  fetchAdminElections,
} from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(ballots);
  await db.delete(candidates);
  await db.delete(electionEligibility);
  await db.delete(elections);
  await db.delete(properties);
});

async function seedElection(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(elections)
    .values({
      id,
      meetingId: null,
      title: `Election ${id}`,
      seats: 2,
      electionDate: '2026-09-14',
      source: 'recorded',
      status: 'closed',
      visibility: 'public',
      certifiedAt: null,
      certifiedBy: null,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

async function seedCandidate(
  id: string,
  electionId: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(candidates)
    .values({
      id,
      electionId,
      fullName: `Candidate ${id}`,
      boardPersonId: null,
      statementMd: null,
      sequence: 0,
      votes: null,
      won: false,
      withdrawn: false,
      createdAt: now,
      ...overrides,
    });
}

async function seedProperty(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Ashebrook Lane`,
      addressNormalized: `${id} ashebrook lane`,
      status: 'active',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

async function seedBallot(
  id: string,
  electionId: string,
  propertyId: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(ballots)
    .values({
      id,
      electionId,
      propertyId,
      weight: 1,
      castByOwnerId: null,
      recordedAt: now,
      ...overrides,
    });
}

describe('election read helpers', () => {
  it('hides draft elections from a visitor', async () => {
    await seedElection('e1', { status: 'draft', visibility: 'public' });
    expect((await fetchElectionsFor(env, 'visitor')).length).toBe(0);
  });

  it('hides draft elections from a BOARD caller too', async () => {
    await seedElection('e1', { status: 'draft', visibility: 'board' });
    await seedElection('e2', { status: 'closed', visibility: 'board' });
    const rows = await fetchElectionsFor(env, 'board');
    expect(rows.map((r) => r.id)).toEqual(['e2']);
  });

  it('hides void elections from a board caller on the public read', async () => {
    await seedElection('e1', { status: 'void', visibility: 'board' });
    await seedElection('e2', { status: 'certified', visibility: 'board' });
    const rows = await fetchElectionsFor(env, 'board');
    expect(rows.map((r) => r.id)).toEqual(['e2']);
  });

  it('returns closed and certified elections', async () => {
    await seedElection('closed', { status: 'closed', visibility: 'public' });
    await seedElection('certified', {
      status: 'certified',
      visibility: 'public',
    });
    await seedElection('draft', { status: 'draft', visibility: 'public' });
    await seedElection('void', { status: 'void', visibility: 'public' });
    const rows = await fetchElectionsFor(env, 'visitor');
    expect(rows.map((r) => r.id).sort()).toEqual(['certified', 'closed']);
  });

  it('applies the visibility tier', async () => {
    await seedElection('pub', { status: 'closed', visibility: 'public' });
    await seedElection('ho', { status: 'closed', visibility: 'homeowner' });
    await seedElection('bd', { status: 'closed', visibility: 'board' });
    expect((await fetchElectionsFor(env, 'visitor')).map((r) => r.id)).toEqual([
      'pub',
    ]);
    expect(
      (await fetchElectionsFor(env, 'homeowner')).map((r) => r.id).sort(),
    ).toEqual(['ho', 'pub']);
    expect((await fetchElectionsFor(env, 'board')).length).toBe(3);
  });

  it('returns candidates ordered by sequence', async () => {
    await seedElection('e1', { status: 'closed', visibility: 'public' });
    await seedCandidate('c-second', 'e1', { sequence: 2 });
    await seedCandidate('c-first', 'e1', { sequence: 1 });
    await seedCandidate('c-third', 'e1', { sequence: 3 });
    const rows = await fetchElectionsFor(env, 'visitor');
    const e1 = rows.find((r) => r.id === 'e1');
    expect(e1).toBeDefined();
    expect(e1?.candidates.map((c) => c.id)).toEqual([
      'c-first',
      'c-second',
      'c-third',
    ]);
  });

  it('computes turnout from the ballot set', async () => {
    await seedElection('e1', { status: 'closed', visibility: 'public' });
    // Three ACTIVE lots (p1, p2, p3) and one inactive one (p4), so
    // eligibleCount (3) and eligibleWeight (7 = 1+2+4) are both distinct
    // from ballotsCast and weightCast below — a mutation aliasing a
    // numerator to its denominator would be caught, not accidentally pass.
    await seedProperty('p1', { voteWeight: 1 });
    await seedProperty('p2', { voteWeight: 2 });
    await seedProperty('p3', { voteWeight: 4 });
    await seedProperty('p4', { voteWeight: 100, status: 'inactive' });
    // p1's ballot matches its live weight; p2's ballot is recorded at 5,
    // deliberately different from p2's CURRENT voteWeight of 2 — this is
    // the snapshot ADR 0015 exists to protect. weightCast must come from
    // the stored ballots.weight (1 + 5 = 6), never from re-reading
    // properties.voteWeight live (which would wrongly sum to 1 + 2 = 3).
    await seedBallot('b1', 'e1', 'p1', { weight: 1 });
    await seedBallot('b2', 'e1', 'p2', { weight: 5 });

    const rows = await fetchElectionsFor(env, 'visitor');
    const e1 = rows.find((r) => r.id === 'e1');
    expect(e1).toBeDefined();
    expect(e1?.turnout).toEqual({
      ballotsCast: 2,
      weightCast: 6,
      eligibleCount: 3,
      eligibleWeight: 7,
      eligibilityFrozen: false,
    });
    expect(e1?.eligibleProperties).toBeNull();
  });

  it('keeps conducted-election eligibility frozen after the roster changes', async () => {
    const db = getDb(env);
    await seedElection('e1', {
      source: 'conducted',
      status: 'closed',
      visibility: 'public',
    });
    await seedProperty('property-a', { voteWeight: 1 });
    await seedProperty('property-b', { voteWeight: 2 });
    // Reverse insertion order so the expected board-only list also pins its
    // deterministic property-id ordering rather than SQLite row order.
    await db.insert(electionEligibility).values([
      { electionId: 'e1', propertyId: 'property-b', weight: 2 },
      { electionId: 'e1', propertyId: 'property-a', weight: 1 },
    ]);

    // The live roster now says one eligible lot with weight 11. Historical
    // turnout must continue to report the two-lot, weight-3 snapshot.
    await db
      .update(properties)
      .set({ voteWeight: 11 })
      .where(eq(properties.id, 'property-a'));
    await db
      .update(properties)
      .set({ voteWeight: 22, status: 'inactive' })
      .where(eq(properties.id, 'property-b'));

    const publicDetail = (await fetchElectionsFor(env, 'visitor')).find(
      (election) => election.id === 'e1',
    );
    expect(publicDetail?.turnout).toMatchObject({
      eligibleCount: 2,
      eligibleWeight: 3,
      eligibilityFrozen: true,
    });
    expect(publicDetail?.eligibleProperties).toBeNull();

    const adminDetail = (await fetchAdminElections(env)).find(
      (election) => election.id === 'e1',
    );
    expect(adminDetail?.eligibleProperties).toEqual([
      {
        propertyId: 'property-a',
        address: 'property-a Ashebrook Lane',
        weight: 1,
      },
      {
        propertyId: 'property-b',
        address: 'property-b Ashebrook Lane',
        weight: 2,
      },
    ]);
  });

  it('keeps snapshot and fallback eligibility isolated across one multi-election read', async () => {
    const db = getDb(env);
    await seedElection('snapshot-one', { source: 'conducted' });
    await seedElection('snapshot-two', { source: 'conducted' });
    await seedElection('fallback', { source: 'recorded' });
    await seedProperty('property-a', { voteWeight: 1 });
    await seedProperty('property-b', { voteWeight: 2 });
    await seedProperty('property-c', { voteWeight: 4 });
    await db.insert(electionEligibility).values([
      { electionId: 'snapshot-one', propertyId: 'property-a', weight: 1 },
      { electionId: 'snapshot-one', propertyId: 'property-b', weight: 2 },
      { electionId: 'snapshot-two', propertyId: 'property-b', weight: 7 },
    ]);

    await db
      .update(properties)
      .set({ voteWeight: 10 })
      .where(eq(properties.id, 'property-a'));
    await db
      .update(properties)
      .set({ voteWeight: 22, status: 'inactive' })
      .where(eq(properties.id, 'property-b'));

    const publicById = new Map(
      (await fetchElectionsFor(env, 'visitor')).map((election) => [
        election.id,
        election,
      ]),
    );
    expect(publicById.get('snapshot-one')?.turnout).toMatchObject({
      eligibleCount: 2,
      eligibleWeight: 3,
      eligibilityFrozen: true,
    });
    expect(publicById.get('snapshot-two')?.turnout).toMatchObject({
      eligibleCount: 1,
      eligibleWeight: 7,
      eligibilityFrozen: true,
    });
    expect(publicById.get('fallback')?.turnout).toMatchObject({
      eligibleCount: 2,
      eligibleWeight: 14,
      eligibilityFrozen: false,
    });
    for (const election of publicById.values()) {
      expect(election.eligibleProperties).toBeNull();
    }

    const adminById = new Map(
      (await fetchAdminElections(env)).map((election) => [
        election.id,
        election,
      ]),
    );
    expect(adminById.get('snapshot-one')?.eligibleProperties).toEqual([
      {
        propertyId: 'property-a',
        address: 'property-a Ashebrook Lane',
        weight: 1,
      },
      {
        propertyId: 'property-b',
        address: 'property-b Ashebrook Lane',
        weight: 2,
      },
    ]);
    expect(adminById.get('snapshot-two')?.eligibleProperties).toEqual([
      {
        propertyId: 'property-b',
        address: 'property-b Ashebrook Lane',
        weight: 7,
      },
    ]);
    expect(adminById.get('fallback')?.eligibleProperties).toEqual([
      {
        propertyId: 'property-a',
        address: 'property-a Ashebrook Lane',
        weight: 10,
      },
      {
        propertyId: 'property-c',
        address: 'property-c Ashebrook Lane',
        weight: 4,
      },
    ]);
  });

  it('reads an election archive larger than the D1 bound-parameter limit', async () => {
    await seedProperty('property-a', { voteWeight: 3 });
    for (let index = 0; index < 101; index += 1) {
      await seedElection(`archive-${index.toString().padStart(3, '0')}`);
    }

    const rows = await fetchElectionsFor(env, 'visitor');

    expect(rows).toHaveLength(101);
    for (const election of rows) {
      expect(election.turnout).toMatchObject({
        eligibleCount: 1,
        eligibleWeight: 3,
        eligibilityFrozen: false,
      });
      expect(election.eligibleProperties).toBeNull();
    }
  });

  it('never returns the per-lot ballot list on the public read', async () => {
    await seedElection('e1', { status: 'closed', visibility: 'public' });
    await seedProperty('p1');
    await seedBallot('b1', 'e1', 'p1');

    const rows = await fetchElectionsFor(env, 'visitor');
    const e1 = rows.find((r) => r.id === 'e1');
    expect(e1).toBeDefined();
    expect(e1?.ballots).toBeNull();
  });

  it('returns the per-lot ballot list on the admin read', async () => {
    // Same fixture as the previous test — the positive control proving the
    // lot is real, not that the fixture happened to be empty. A second
    // ballot, inserted in reverse property-id order, also pins the list's
    // ordering rather than leaving it to unspecified SQLite row order.
    await seedElection('e1', { status: 'closed', visibility: 'public' });
    await seedProperty('p1');
    await seedProperty('p2');
    await seedBallot('b2', 'e1', 'p2');
    await seedBallot('b1', 'e1', 'p1');

    const rows = await fetchAdminElections(env);
    const e1 = rows.find((r) => r.id === 'e1');
    expect(e1).toBeDefined();
    expect(e1?.ballots).toEqual([
      {
        propertyId: 'p1',
        address: 'p1 Ashebrook Lane',
        weight: 1,
        viaProxy: false,
        castByOwnerId: null,
        proxyId: null,
      },
      {
        propertyId: 'p2',
        address: 'p2 Ashebrook Lane',
        weight: 1,
        viaProxy: false,
        castByOwnerId: null,
        proxyId: null,
      },
    ]);
  });

  it('shows drafts and void elections to the admin read', async () => {
    await seedElection('draft', { status: 'draft', visibility: 'board' });
    await seedElection('void', { status: 'void', visibility: 'board' });
    await seedElection('closed', { status: 'closed', visibility: 'public' });
    const rows = await fetchAdminElections(env);
    expect(rows.map((r) => r.id).sort()).toEqual(['closed', 'draft', 'void']);
  });

  it('distinguishes a null tally from a recorded zero', async () => {
    await seedElection('e1', { status: 'closed', visibility: 'public' });
    await seedCandidate('c-null', 'e1', { sequence: 1, votes: null });
    await seedCandidate('c-zero', 'e1', { sequence: 2, votes: 0 });

    const rows = await fetchElectionsFor(env, 'visitor');
    const e1 = rows.find((r) => r.id === 'e1');
    expect(e1).toBeDefined();
    const cNull = e1?.candidates.find((c) => c.id === 'c-null');
    const cZero = e1?.candidates.find((c) => c.id === 'c-zero');
    expect(cNull?.votes).toBeNull();
    expect(cZero?.votes).toBe(0);
  });
});
