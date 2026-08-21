import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  owners,
  meetings,
  memberAttendance,
  memberVotes,
  motions,
} from '../../src/server/db/schema';
import {
  now,
  truncateAll,
  seedProperty,
  seedMeeting,
  seedPerson,
} from './fixtures';
import { people } from '../../src/server/db/roster-schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(truncateAll);

describe('member meeting schema', () => {
  it('defaults an existing property to vote weight 1', async () => {
    await seedProperty('p1');
    const rows = await getDb(env)
      .select()
      .from(properties)
      .where(eq(properties.id, 'p1'));
    expect(rows[0].voteWeight).toBe(1);
  });

  it('stores a property with a heavier vote weight', async () => {
    await seedProperty('p2', { voteWeight: 3 });
    const rows = await getDb(env)
      .select()
      .from(properties)
      .where(eq(properties.id, 'p2'));
    expect(rows[0].voteWeight).toBe(3);
  });

  it('records member attendance per property with an optional representative', async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await db.insert(owners).values({
      id: 'o1',
      propertyId: 'p1',
      fullName: 'A. Reyes',
      createdAt: now,
      updatedAt: now,
    });
    await seedMeeting('m1');
    await db.insert(memberAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      propertyId: 'p1',
      present: true,
      representedByOwnerId: 'o1',
    });
    const rows = await db.select().from(memberAttendance);
    expect(rows.length).toBe(1);
    expect(rows[0].representedByOwnerId).toBe('o1');
    expect(rows[0].proxyId).toBeNull();
  });

  it('allows attendance with no named representative', async () => {
    await seedProperty('p1');
    await seedMeeting('m1');
    await getDb(env).insert(memberAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      propertyId: 'p1',
      present: true,
      representedByOwnerId: null,
    });
    const rows = await getDb(env).select().from(memberAttendance);
    expect(rows[0].representedByOwnerId).toBeNull();
  });

  it('rejects a second attendance row for the same property at one meeting', async () => {
    await seedProperty('p1');
    await seedMeeting('m1');
    const db = getDb(env);
    await db.insert(memberAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      propertyId: 'p1',
      present: true,
      representedByOwnerId: null,
    });
    await expect(
      db.insert(memberAttendance).values({
        id: 'a2',
        meetingId: 'm1',
        propertyId: 'p1',
        present: false,
        representedByOwnerId: null,
      }),
    ).rejects.toThrow();
  });

  it('rejects a second member vote from the same property on one motion', async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await seedMeeting('m1');
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'Adopt the assessment',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(memberVotes).values({
      id: 'v1',
      motionId: 'mo1',
      propertyId: 'p1',
      castByOwnerId: null,
      weight: 1,
      choice: 'yes',
    });
    await expect(
      db.insert(memberVotes).values({
        id: 'v2',
        motionId: 'mo1',
        propertyId: 'p1',
        castByOwnerId: null,
        weight: 1,
        choice: 'no',
      }),
    ).rejects.toThrow();
  });

  it('refuses to delete a property that has voted', async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await seedMeeting('m1');
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(memberVotes).values({
      id: 'v1',
      motionId: 'mo1',
      propertyId: 'p1',
      castByOwnerId: null,
      weight: 1,
      choice: 'yes',
    });
    await expect(
      db.delete(properties).where(eq(properties.id, 'p1')),
    ).rejects.toThrow();
    expect((await db.select().from(properties)).length).toBe(1);
  });

  it('cascades member attendance and votes when the meeting is deleted', async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await seedMeeting('m1');
    await db.insert(memberAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      propertyId: 'p1',
      present: true,
      representedByOwnerId: null,
    });
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(memberVotes).values({
      id: 'v1',
      motionId: 'mo1',
      propertyId: 'p1',
      castByOwnerId: null,
      weight: 1,
      choice: 'yes',
    });
    await db.delete(meetings).where(eq(meetings.id, 'm1'));
    expect((await db.select().from(memberAttendance)).length).toBe(0);
    expect((await db.select().from(memberVotes)).length).toBe(0);
  });

  it('stores a roster Person as a motion mover', async () => {
    const db = getDb(env);
    await seedPerson('pe1');
    await seedMeeting('m1');
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: 'pe1',
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db.select().from(motions);
    expect(rows[0].moverPersonId).toBe('pe1');
  });

  // #248 replaced the pair of tests that used to live here, which pinned
  // `motions.mover_owner_id` — a column added by ALTER TABLE, so drizzle-kit
  // had dropped its ON DELETE action and the live database enforced SQLite's
  // default NO ACTION rather than the declared RESTRICT. Those tests carried a
  // long caveat explaining that NO ACTION and RESTRICT happen to reject an
  // in-use delete identically under non-deferred constraints, and would only
  // diverge if deferred constraints were ever introduced.
  //
  // The caveat is retired along with the column: the repointed FK was created
  // through CREATE TABLE, which emits its action, so RESTRICT is now literally
  // what the database enforces. This asserts the rejection without the asterisk.
  it('refuses to delete a Person who moved a motion', async () => {
    const db = getDb(env);
    await seedPerson('pe1');
    await seedMeeting('m1');
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: 'pe1',
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      db.delete(people).where(eq(people.partyId, 'pe1')),
    ).rejects.toThrow();
    expect((await db.select().from(people)).length).toBe(1);
  });
});
