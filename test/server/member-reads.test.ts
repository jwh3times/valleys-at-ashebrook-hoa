import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  owners,
  meetings,
  motions,
  memberAttendance,
  memberVotes,
} from '../../src/server/db/schema';
import {
  fetchAdminMeeting,
  fetchMeetingFor,
} from '../../src/server/content/reads';

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

async function seedProperty(
  id: string,
  opts: { weight?: number; status?: 'active' | 'inactive' } = {},
) {
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Oak St`,
      addressNormalized: `${id} oak st`,
      ...(opts.weight === undefined ? {} : { voteWeight: opts.weight }),
      ...(opts.status === undefined ? {} : { status: opts.status }),
      createdAt: now,
      updatedAt: now,
    });
}

async function seedOwner(id: string, propertyId: string, fullName: string) {
  await getDb(env).insert(owners).values({
    id,
    propertyId,
    fullName,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedMeeting(id: string, body: 'board' | 'member' = 'member') {
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body,
      kind: 'annual',
      date: '2026-09-14',
      title: `Meeting ${id}`,
      status: 'draft',
      visibility: 'board',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
}

async function seedMotion(id: string, meetingId: string, sequence = 1) {
  await getDb(env)
    .insert(motions)
    .values({
      id,
      meetingId,
      sequence,
      text: `Motion ${id}`,
      moverPersonId: null,
      secondPersonId: null,
      moverOwnerId: null,
      secondOwnerId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
}

describe('member meeting assembly', () => {
  it('populates memberAttendance for a member meeting with per-property weight', async () => {
    const db = getDb(env);
    await seedProperty('p1', { weight: 2 });
    await seedMeeting('m1');
    await db.insert(memberAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      propertyId: 'p1',
      present: true,
      representedByOwnerId: null,
      viaProxy: false,
    });

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.memberAttendance).toEqual([
      {
        propertyId: 'p1',
        address: 'p1 Oak St',
        present: true,
        weight: 2,
        representedByName: null,
        viaProxy: false,
      },
    ]);
  });

  it("resolves the representing owner's name, and leaves it null when absent", async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await seedProperty('p2');
    await seedOwner('o1', 'p1', 'A. Reyes');
    await seedMeeting('m1');
    await db.insert(memberAttendance).values([
      {
        id: 'a1',
        meetingId: 'm1',
        propertyId: 'p1',
        present: true,
        representedByOwnerId: 'o1',
        viaProxy: true,
      },
      {
        id: 'a2',
        meetingId: 'm1',
        propertyId: 'p2',
        present: true,
        representedByOwnerId: null,
        viaProxy: false,
      },
    ]);

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    const byProperty = new Map(
      detail.memberAttendance.map((a) => [a.propertyId, a]),
    );
    expect(byProperty.get('p1')?.representedByName).toBe('A. Reyes');
    expect(byProperty.get('p1')?.viaProxy).toBe(true);
    expect(byProperty.get('p2')?.representedByName).toBeNull();
  });

  it('computes totalActiveWeight as the summed weight of ACTIVE properties only', async () => {
    await seedProperty('p1', { weight: 2, status: 'active' });
    await seedProperty('p2', { weight: 3, status: 'active' });
    await seedMeeting('m1');

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.totalActiveWeight).toBe(5);
  });

  it('excludes inactive properties from totalActiveWeight', async () => {
    await seedProperty('p1', { weight: 2, status: 'active' });
    await seedProperty('p2', { weight: 10, status: 'inactive' });
    await seedMeeting('m1');

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.totalActiveWeight).toBe(2);
  });

  it('returns memberTally summing weight, not counting rows', async () => {
    // Deliberately mismatched: each property's CURRENT voteWeight (99, 42)
    // is nothing like the vote's STORED weight (3, 5). An implementation
    // that resolved weight via weightOf.get(propertyId) instead of reading
    // the row's own `weight` column would sum to 141, not 8 — this is the
    // seed shape that actually exercises the snapshot invariant
    // (schema.ts:355-358: correcting a property's weight later must not
    // rewrite past tallies).
    const db = getDb(env);
    await seedProperty('p1', { weight: 99 });
    await seedProperty('p2', { weight: 42 });
    await seedMeeting('m1');
    await seedMotion('mo1', 'm1');
    await db.insert(memberVotes).values([
      {
        id: 'v1',
        motionId: 'mo1',
        propertyId: 'p1',
        castByOwnerId: null,
        viaProxy: false,
        weight: 3,
        choice: 'yes',
      },
      {
        id: 'v2',
        motionId: 'mo1',
        propertyId: 'p2',
        castByOwnerId: null,
        viaProxy: false,
        weight: 5,
        choice: 'yes',
      },
    ]);

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.motions[0].memberTally).toEqual({
      yes: 8,
      no: 0,
      abstain: 0,
      recused: 0,
      absent: 0,
      recorded: true,
    });
  });

  it('reports memberTally.recorded false for a motion with no member votes', async () => {
    await seedProperty('p1');
    await seedMeeting('m1');
    await seedMotion('mo1', 'm1');

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.motions[0].memberTally.recorded).toBe(false);
  });

  it("scopes member votes per motion — a second motion's votes never leak in", async () => {
    const db = getDb(env);
    await seedProperty('p1', { weight: 1 });
    await seedProperty('p2', { weight: 1 });
    await seedMeeting('m1');
    await seedMotion('mo1', 'm1', 1);
    await seedMotion('mo2', 'm1', 2);
    await db.insert(memberVotes).values([
      {
        id: 'v1',
        motionId: 'mo1',
        propertyId: 'p1',
        castByOwnerId: null,
        viaProxy: false,
        weight: 1,
        choice: 'yes',
      },
      {
        id: 'v2',
        motionId: 'mo2',
        propertyId: 'p2',
        castByOwnerId: null,
        viaProxy: false,
        weight: 1,
        choice: 'no',
      },
    ]);

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    const byId = new Map(detail.motions.map((m) => [m.id, m]));
    expect(byId.get('mo1')?.memberVotes.map((v) => v.propertyId)).toEqual([
      'p1',
    ]);
    expect(byId.get('mo2')?.memberVotes.map((v) => v.propertyId)).toEqual([
      'p2',
    ]);
  });

  it("scopes member attendance per meeting — a second meeting's rows never leak in", async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await seedProperty('p2');
    await seedMeeting('m1');
    await seedMeeting('m2');
    await db.insert(memberAttendance).values([
      {
        id: 'a1',
        meetingId: 'm1',
        propertyId: 'p1',
        present: true,
        representedByOwnerId: null,
        viaProxy: false,
      },
      {
        id: 'a2',
        meetingId: 'm2',
        propertyId: 'p2',
        present: false,
        representedByOwnerId: null,
        viaProxy: false,
      },
    ]);

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.memberAttendance.map((a) => a.propertyId)).toEqual(['p1']);
  });

  it('returns empty member arrays for a board meeting', async () => {
    const db = getDb(env);
    await seedProperty('p1', { weight: 4, status: 'active' });
    await seedMeeting('m1', 'board');
    await seedMotion('mo1', 'm1');
    // A board meeting still tolerates member rows existing (defense in
    // depth) — the assembler branches on nothing, it simply finds none
    // scoped to this meeting/motion because none were inserted for them.

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.memberAttendance).toEqual([]);
    expect(detail.motions[0].memberVotes).toEqual([]);
    expect(detail.motions[0].memberTally.recorded).toBe(false);
    // totalActiveWeight is computed unconditionally, not gated on `body` —
    // it is populated here too, not zeroed for a board meeting. Consumers
    // must gate display on body === 'member', not on this value.
    expect(detail.totalActiveWeight).toBe(4);
  });

  it('coalesces totalActiveWeight to 0 when there are no active properties', async () => {
    await seedProperty('p1', { weight: 10, status: 'inactive' });
    await seedMeeting('m1');

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    // SQLite's SUM() returns NULL over zero matching rows; if the coalesce
    // in reads.ts were dropped this would be `null` at runtime despite the
    // `number` type, a silent type lie reaching callers.
    expect(detail.totalActiveWeight).toBe(0);
  });

  it('still hides drafts from a board caller after these additions', async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await seedMeeting('m1', 'member');
    await seedMotion('mo1', 'm1');
    await db.insert(memberAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      propertyId: 'p1',
      present: true,
      representedByOwnerId: null,
      viaProxy: false,
    });
    // seedMeeting always creates a 'draft' meeting — the member-assembly
    // additions in this file must not have loosened fetchMeetingFor's
    // status/tier gate, even though the meeting now has member rows to
    // assemble.
    expect(await fetchMeetingFor(env, 'board', 'm1')).toBeNull();
  });
});
