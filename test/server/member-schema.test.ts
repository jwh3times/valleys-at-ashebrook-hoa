import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  owners,
  meetings,
  motions,
  memberAttendance,
  memberVotes,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberVotes);
  await db.delete(memberAttendance);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
});

async function seedProperty(id: string, weight?: number) {
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Oak St`,
      addressNormalized: `${id} oak st`,
      ...(weight === undefined ? {} : { voteWeight: weight }),
      createdAt: now,
      updatedAt: now,
    });
}

async function seedMeeting(id: string, body: 'board' | 'member' = 'member') {
  await getDb(env).insert(meetings).values({
    id,
    body,
    kind: 'annual',
    date: '2026-09-14',
    title: 'Annual meeting',
    status: 'draft',
    visibility: 'board',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  });
}

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
    await seedProperty('p2', 3);
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
      viaProxy: false,
    });
    const rows = await db.select().from(memberAttendance);
    expect(rows.length).toBe(1);
    expect(rows[0].representedByOwnerId).toBe('o1');
    expect(rows[0].viaProxy).toBe(false);
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
      viaProxy: false,
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
      viaProxy: false,
    });
    await expect(
      db.insert(memberAttendance).values({
        id: 'a2',
        meetingId: 'm1',
        propertyId: 'p1',
        present: false,
        representedByOwnerId: null,
        viaProxy: false,
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
      moverOwnerId: null,
      secondOwnerId: null,
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
      viaProxy: false,
      weight: 1,
      choice: 'yes',
    });
    await expect(
      db.insert(memberVotes).values({
        id: 'v2',
        motionId: 'mo1',
        propertyId: 'p1',
        castByOwnerId: null,
        viaProxy: false,
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
      moverOwnerId: null,
      secondOwnerId: null,
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
      viaProxy: false,
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
      viaProxy: false,
    });
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: null,
      secondPersonId: null,
      moverOwnerId: null,
      secondOwnerId: null,
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
      viaProxy: false,
      weight: 1,
      choice: 'yes',
    });
    await db.delete(meetings).where(eq(meetings.id, 'm1'));
    expect((await db.select().from(memberAttendance)).length).toBe(0);
    expect((await db.select().from(memberVotes)).length).toBe(0);
  });

  it('stores an owner as a motion mover for a member meeting', async () => {
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
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: null,
      secondPersonId: null,
      moverOwnerId: 'o1',
      secondOwnerId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db.select().from(motions);
    expect(rows[0].moverOwnerId).toBe('o1');
    expect(rows[0].moverPersonId).toBeNull();
  });
});
