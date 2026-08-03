import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import {
  elections,
  candidates,
  ballots,
  meetings,
  properties,
  boardPeople,
  boardTerms,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.update(boardTerms).set({ electionId: null });
  await db.delete(ballots);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(boardTerms);
  await db.delete(boardPeople);
  await db.delete(meetings);
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
      electionDate: '2026-09-15',
      source: 'recorded',
      status: 'draft',
      visibility: 'board',
      certifiedAt: null,
      certifiedBy: null,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
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
      address: `${id} Main St`,
      addressNormalized: `${id} main st`,
      unit: null,
      status: 'active',
      voteWeight: 1,
      notes: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

async function seedBoardPerson(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(boardPeople)
    .values({
      id,
      fullName: `Person ${id}`,
      userId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

describe('elections schema', () => {
  it('creates an election with the recorded default', async () => {
    await getDb(env).insert(elections).values({
      id: 'e1',
      meetingId: null,
      title: 'Board Election 2026',
      seats: 3,
      electionDate: '2026-09-15',
      status: 'draft',
      visibility: 'board',
      certifiedAt: null,
      certifiedBy: null,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    const rows = await getDb(env)
      .select()
      .from(elections)
      .where(eq(elections.id, 'e1'));
    expect(rows[0].source).toBe('recorded');
    expect(rows[0].status).toBe('draft');
    expect(rows[0].visibility).toBe('board');
  });

  it('rejects a candidate whose election does not exist', async () => {
    await expect(
      getDb(env).insert(candidates).values({
        id: 'c1',
        electionId: 'does-not-exist',
        fullName: 'Jane Doe',
        boardPersonId: null,
        statementMd: null,
        sequence: 1,
        votes: null,
        won: false,
        withdrawn: false,
        createdAt: now,
      }),
    ).rejects.toThrow();
  });

  it('cascades candidates when an election is deleted', async () => {
    const db = getDb(env);
    await seedElection('e1');
    await db.insert(candidates).values({
      id: 'c1',
      electionId: 'e1',
      fullName: 'Jane Doe',
      boardPersonId: null,
      statementMd: null,
      sequence: 1,
      votes: null,
      won: false,
      withdrawn: false,
      createdAt: now,
    });
    await db.delete(elections).where(eq(elections.id, 'e1'));
    const rows = await db.select().from(candidates);
    expect(rows.length).toBe(0);
  });

  it('cascades ballots when an election is deleted', async () => {
    const db = getDb(env);
    await seedElection('e1');
    await seedProperty('p1');
    await db.insert(ballots).values({
      id: 'b1',
      electionId: 'e1',
      propertyId: 'p1',
      weight: 1,
      castByOwnerId: null,
      recordedAt: now,
    });
    await db.delete(elections).where(eq(elections.id, 'e1'));
    const rows = await db.select().from(ballots);
    expect(rows.length).toBe(0);
  });

  it('refuses to delete a property that has returned a ballot', async () => {
    const db = getDb(env);
    await seedElection('e1');
    await seedProperty('p1');
    await db.insert(ballots).values({
      id: 'b1',
      electionId: 'e1',
      propertyId: 'p1',
      weight: 1,
      castByOwnerId: null,
      recordedAt: now,
    });
    await expect(
      db.delete(properties).where(eq(properties.id, 'p1')),
    ).rejects.toThrow();
  });

  it('refuses to delete a board person linked to a candidate', async () => {
    const db = getDb(env);
    await seedElection('e1');
    await seedBoardPerson('bp1');
    await db.insert(candidates).values({
      id: 'c1',
      electionId: 'e1',
      fullName: 'Jane Doe',
      boardPersonId: 'bp1',
      statementMd: null,
      sequence: 1,
      votes: null,
      won: false,
      withdrawn: false,
      createdAt: now,
    });
    await expect(
      db.delete(boardPeople).where(eq(boardPeople.id, 'bp1')),
    ).rejects.toThrow();
  });

  it('sets meeting_id to null when the meeting is deleted', async () => {
    const db = getDb(env);
    await db.insert(meetings).values({
      id: 'm1',
      body: 'board',
      kind: 'annual',
      date: '2026-09-15',
      title: 'Annual Meeting',
      status: 'draft',
      visibility: 'board',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await seedElection('e1', { meetingId: 'm1' });
    await db.delete(meetings).where(eq(meetings.id, 'm1'));
    const rows = await db
      .select()
      .from(elections)
      .where(eq(elections.id, 'e1'));
    expect(rows[0].meetingId).toBeNull();
  });

  it('allows one ballot per property per election and rejects a second', async () => {
    const db = getDb(env);
    await seedElection('e1');
    await seedProperty('p1');
    await db.insert(ballots).values({
      id: 'b1',
      electionId: 'e1',
      propertyId: 'p1',
      weight: 1,
      castByOwnerId: null,
      recordedAt: now,
    });
    await expect(
      db.insert(ballots).values({
        id: 'b2',
        electionId: 'e1',
        propertyId: 'p1',
        weight: 1,
        castByOwnerId: null,
        recordedAt: now,
      }),
    ).rejects.toThrow();
  });

  it('allows the same property to vote in two different elections', async () => {
    const db = getDb(env);
    await seedElection('e1');
    await seedElection('e2');
    await seedProperty('p1');
    await db.insert(ballots).values({
      id: 'b1',
      electionId: 'e1',
      propertyId: 'p1',
      weight: 1,
      castByOwnerId: null,
      recordedAt: now,
    });
    await db.insert(ballots).values({
      id: 'b2',
      electionId: 'e2',
      propertyId: 'p1',
      weight: 1,
      castByOwnerId: null,
      recordedAt: now,
    });
    const rows = await db.select().from(ballots);
    expect(rows.length).toBe(2);
  });

  it('records a null votes value distinctly from zero', async () => {
    const db = getDb(env);
    await seedElection('e1');
    await db.insert(candidates).values({
      id: 'c1',
      electionId: 'e1',
      fullName: 'Not Recorded',
      boardPersonId: null,
      statementMd: null,
      sequence: 1,
      votes: null,
      won: false,
      withdrawn: false,
      createdAt: now,
    });
    await db.insert(candidates).values({
      id: 'c2',
      electionId: 'e1',
      fullName: 'Recorded Zero',
      boardPersonId: null,
      statementMd: null,
      sequence: 2,
      votes: 0,
      won: false,
      withdrawn: false,
      createdAt: now,
    });
    const rows = await db.select().from(candidates);
    const c1 = rows.find((r) => r.id === 'c1');
    const c2 = rows.find((r) => r.id === 'c2');
    expect(c1?.votes).toBeNull();
    expect(c2?.votes).toBe(0);
  });

  it('the generated 0013 SQL carries ON DELETE cascade for candidates and ballots', () => {
    const m = env.MIGRATIONS!.find((x) => x.name.startsWith('0013'));
    expect(m).toBeDefined();
    const candidatesCreate = m!.queries.find(
      (q) => q.includes('CREATE TABLE') && q.includes('`candidates`'),
    );
    const ballotsCreate = m!.queries.find(
      (q) => q.includes('CREATE TABLE') && q.includes('`ballots`'),
    );
    expect(candidatesCreate).toBeDefined();
    expect(ballotsCreate).toBeDefined();
    expect(candidatesCreate).toMatch(/`election_id`.*ON DELETE cascade/is);
    expect(ballotsCreate).toMatch(/`election_id`.*ON DELETE cascade/is);
    expect(ballotsCreate).toMatch(/`property_id`.*ON DELETE restrict/is);
  });

  it('the generated 0013 SQL adds board_terms.election_id WITHOUT an ON DELETE action', () => {
    const m = env.MIGRATIONS!.find((x) => x.name.startsWith('0013'));
    expect(m).toBeDefined();
    const alter = m!.queries.find(
      (q) => q.includes('ALTER TABLE') && q.includes('election_id'),
    );
    expect(alter).toBeDefined();
    // The FK itself IS emitted; only the action is dropped. Pinning both halves
    // keeps the schema comment honest — if a future drizzle-kit starts emitting
    // the action, this fails and the comment gets updated deliberately.
    expect(alter).toMatch(/REFERENCES/i);
    expect(alter).not.toMatch(/ON DELETE/i);
  });

  it('candidates has no updated_at column, by design', async () => {
    const db = getDb(env);
    const cols = await db.run(sql`PRAGMA table_info(candidates)`);
    const names = cols.results.map((c) => (c as Record<string, unknown>).name);
    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });
});
