import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import {
  ballotChoices,
  candidates,
  electionEligibility,
  elections,
  meetings,
  motionEligibility,
  motions,
  properties,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(ballotChoices);
  await db.delete(electionEligibility);
  await db.delete(motionEligibility);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(properties);
});

const now = new Date();

async function pragmaRows(statement: string) {
  const result = await env.DATABASE.prepare(statement).all();
  return result.results as Record<string, unknown>[];
}

async function seedProperty(id: string) {
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
    });
}

async function seedElection(id: string, candidateId?: string) {
  await getDb(env)
    .insert(elections)
    .values({
      id,
      meetingId: null,
      title: `Election ${id}`,
      seats: 1,
      electionDate: '2026-09-15',
      source: 'conducted',
      status: 'draft',
      visibility: 'board',
      certifiedAt: null,
      certifiedBy: null,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });

  if (candidateId) {
    await getDb(env)
      .insert(candidates)
      .values({
        id: candidateId,
        electionId: id,
        fullName: `Candidate ${candidateId}`,
        boardPersonId: null,
        statementMd: null,
        sequence: 1,
        votes: null,
        won: false,
        withdrawn: false,
        createdAt: now,
      });
  }
}

async function seedMotion(meetingId: string, motionId: string) {
  await getDb(env)
    .insert(meetings)
    .values({
      id: meetingId,
      body: 'member',
      kind: 'annual',
      date: '2026-09-15',
      title: `Meeting ${meetingId}`,
      status: 'draft',
      visibility: 'board',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
  await getDb(env)
    .insert(motions)
    .values({
      id: motionId,
      meetingId,
      sequence: 1,
      text: `Motion ${motionId}`,
      moverPersonId: null,
      secondPersonId: null,
      moverOwnerId: null,
      secondOwnerId: null,
      outcome: 'tabled',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
}

describe('live voting schema', () => {
  it('pins the immutable electorate snapshot columns and unique keys', async () => {
    const electionEligibilityColumns = (
      await pragmaRows('PRAGMA table_info(election_eligibility)')
    ).map((column) => column.name);
    const motionEligibilityColumns = (
      await pragmaRows('PRAGMA table_info(motion_eligibility)')
    ).map((column) => column.name);

    expect(electionEligibilityColumns).toEqual([
      'election_id',
      'property_id',
      'weight',
    ]);
    expect(motionEligibilityColumns).toEqual([
      'motion_id',
      'property_id',
      'weight',
    ]);

    const electionIndexes = await pragmaRows(
      'PRAGMA index_list(election_eligibility)',
    );
    const motionIndexes = await pragmaRows(
      'PRAGMA index_list(motion_eligibility)',
    );
    expect(electionIndexes).toContainEqual(
      expect.objectContaining({
        name: 'election_eligibility_parent_property_unq',
        unique: 1,
      }),
    );
    expect(motionIndexes).toContainEqual(
      expect.objectContaining({
        name: 'motion_eligibility_parent_property_unq',
        unique: 1,
      }),
    );

    const electionIndexColumns = (
      await pragmaRows(
        'PRAGMA index_info(election_eligibility_parent_property_unq)',
      )
    ).map((column) => column.name);
    const motionIndexColumns = (
      await pragmaRows(
        'PRAGMA index_info(motion_eligibility_parent_property_unq)',
      )
    ).map((column) => column.name);
    expect(electionIndexColumns).toEqual(['election_id', 'property_id']);
    expect(motionIndexColumns).toEqual(['motion_id', 'property_id']);
  });

  it('pins the live voting foreign-key delete actions', async () => {
    const choices = await pragmaRows('PRAGMA foreign_key_list(ballot_choices)');
    const electionSnapshot = await pragmaRows(
      'PRAGMA foreign_key_list(election_eligibility)',
    );
    const motionSnapshot = await pragmaRows(
      'PRAGMA foreign_key_list(motion_eligibility)',
    );

    const foreignKeys = (rows: Record<string, unknown>[]) =>
      rows
        .map((row) => ({
          from: row.from,
          table: row.table,
          onDelete: row.on_delete,
        }))
        .sort((a, b) => String(a.from).localeCompare(String(b.from)));

    expect(foreignKeys(choices)).toEqual([
      { from: 'candidate_id', table: 'candidates', onDelete: 'RESTRICT' },
      { from: 'election_id', table: 'elections', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys(electionSnapshot)).toEqual([
      { from: 'election_id', table: 'elections', onDelete: 'CASCADE' },
      { from: 'property_id', table: 'properties', onDelete: 'RESTRICT' },
    ]);
    expect(foreignKeys(motionSnapshot)).toEqual([
      { from: 'motion_id', table: 'motions', onDelete: 'CASCADE' },
      { from: 'property_id', table: 'properties', onDelete: 'RESTRICT' },
    ]);
  });

  it('rejects duplicate parent entries but allows the property under other parents', async () => {
    await seedProperty('duplicate-property');
    await seedElection('duplicate-election');
    await seedElection('duplicate-election-2');
    await seedMotion('duplicate-meeting', 'duplicate-motion');
    await seedMotion('duplicate-meeting-2', 'duplicate-motion-2');

    const electionInsert = env.DATABASE.prepare(
      'INSERT INTO election_eligibility (election_id, property_id, weight) VALUES (?, ?, ?)',
    );
    await electionInsert
      .bind('duplicate-election', 'duplicate-property', 1)
      .run();
    await expect(
      electionInsert.bind('duplicate-election', 'duplicate-property', 2).run(),
    ).rejects.toThrow();
    await electionInsert
      .bind('duplicate-election-2', 'duplicate-property', 2)
      .run();

    const motionInsert = env.DATABASE.prepare(
      'INSERT INTO motion_eligibility (motion_id, property_id, weight) VALUES (?, ?, ?)',
    );
    await motionInsert.bind('duplicate-motion', 'duplicate-property', 1).run();
    await expect(
      motionInsert.bind('duplicate-motion', 'duplicate-property', 2).run(),
    ).rejects.toThrow();
    await motionInsert
      .bind('duplicate-motion-2', 'duplicate-property', 2)
      .run();

    const electionRows = await env.DATABASE.prepare(
      'SELECT election_id FROM election_eligibility WHERE property_id = ? ORDER BY election_id',
    )
      .bind('duplicate-property')
      .all();
    const motionRows = await env.DATABASE.prepare(
      'SELECT motion_id FROM motion_eligibility WHERE property_id = ? ORDER BY motion_id',
    )
      .bind('duplicate-property')
      .all();
    expect(electionRows.results.map((row) => row.election_id)).toEqual([
      'duplicate-election',
      'duplicate-election-2',
    ]);
    expect(motionRows.results.map((row) => row.motion_id)).toEqual([
      'duplicate-motion',
      'duplicate-motion-2',
    ]);
  });

  it('rejects negative weights in choices and both electorate snapshots', async () => {
    await seedProperty('zero-property');
    await seedProperty('negative-property');
    await seedElection('negative-election', 'negative-candidate');
    await seedMotion('negative-meeting', 'negative-motion');

    await env.DATABASE.prepare(
      'INSERT INTO ballot_choices (id, election_id, candidate_id, weight) VALUES (?, ?, ?, ?)',
    )
      .bind('zero-choice', 'negative-election', 'negative-candidate', 0)
      .run();
    await env.DATABASE.prepare(
      'INSERT INTO election_eligibility (election_id, property_id, weight) VALUES (?, ?, ?)',
    )
      .bind('negative-election', 'zero-property', 0)
      .run();
    await env.DATABASE.prepare(
      'INSERT INTO motion_eligibility (motion_id, property_id, weight) VALUES (?, ?, ?)',
    )
      .bind('negative-motion', 'zero-property', 0)
      .run();

    await expect(
      env.DATABASE.prepare(
        'INSERT INTO ballot_choices (id, election_id, candidate_id, weight) VALUES (?, ?, ?, ?)',
      )
        .bind('negative-choice', 'negative-election', 'negative-candidate', -1)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DATABASE.prepare(
        'INSERT INTO election_eligibility (election_id, property_id, weight) VALUES (?, ?, ?)',
      )
        .bind('negative-election', 'negative-property', -1)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DATABASE.prepare(
        'INSERT INTO motion_eligibility (motion_id, property_id, weight) VALUES (?, ?, ?)',
      )
        .bind('negative-motion', 'negative-property', -1)
        .run(),
    ).rejects.toThrow();
  });

  it('cascades choices and electorate snapshots with their parent', async () => {
    await seedProperty('cascade-property');
    await seedElection('cascade-election', 'cascade-candidate');
    await seedMotion('cascade-meeting', 'cascade-motion');

    await env.DATABASE.prepare(
      'INSERT INTO ballot_choices (id, election_id, candidate_id, weight) VALUES (?, ?, ?, ?)',
    )
      .bind('cascade-choice', 'cascade-election', 'cascade-candidate', 1)
      .run();
    await env.DATABASE.prepare(
      'INSERT INTO election_eligibility (election_id, property_id, weight) VALUES (?, ?, ?)',
    )
      .bind('cascade-election', 'cascade-property', 1)
      .run();
    await env.DATABASE.prepare(
      'INSERT INTO motion_eligibility (motion_id, property_id, weight) VALUES (?, ?, ?)',
    )
      .bind('cascade-motion', 'cascade-property', 1)
      .run();

    await getDb(env)
      .delete(elections)
      .where(eq(elections.id, 'cascade-election'));
    await getDb(env).delete(motions).where(eq(motions.id, 'cascade-motion'));

    const choiceRows = await env.DATABASE.prepare(
      "SELECT COUNT(*) AS count FROM ballot_choices WHERE election_id = 'cascade-election'",
    ).first<{ count: number }>();
    const electionRows = await env.DATABASE.prepare(
      "SELECT COUNT(*) AS count FROM election_eligibility WHERE election_id = 'cascade-election'",
    ).first<{ count: number }>();
    const motionRows = await env.DATABASE.prepare(
      "SELECT COUNT(*) AS count FROM motion_eligibility WHERE motion_id = 'cascade-motion'",
    ).first<{ count: number }>();
    expect(choiceRows?.count).toBe(0);
    expect(electionRows?.count).toBe(0);
    expect(motionRows?.count).toBe(0);
  });

  it('restricts property and candidate deletion while live voting rows cite them', async () => {
    await seedProperty('restrict-property');
    await seedElection('restrict-election', 'restrict-candidate');
    await seedMotion('restrict-meeting', 'restrict-motion');

    await env.DATABASE.prepare(
      'INSERT INTO ballot_choices (id, election_id, candidate_id, weight) VALUES (?, ?, ?, ?)',
    )
      .bind('restrict-choice', 'restrict-election', 'restrict-candidate', 1)
      .run();
    await env.DATABASE.prepare(
      'INSERT INTO election_eligibility (election_id, property_id, weight) VALUES (?, ?, ?)',
    )
      .bind('restrict-election', 'restrict-property', 1)
      .run();
    await env.DATABASE.prepare(
      'INSERT INTO motion_eligibility (motion_id, property_id, weight) VALUES (?, ?, ?)',
    )
      .bind('restrict-motion', 'restrict-property', 1)
      .run();

    await expect(
      getDb(env)
        .delete(properties)
        .where(eq(properties.id, 'restrict-property')),
    ).rejects.toThrow();
    await expect(
      getDb(env)
        .delete(candidates)
        .where(eq(candidates.id, 'restrict-candidate')),
    ).rejects.toThrow();
  });
});
