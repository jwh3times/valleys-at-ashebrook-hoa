import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import * as fx from './fixtures';
import {
  properties,
  owners,
  meetings,
  motions,
  memberAttendance,
  memberVotes,
  elections,
  proxies,
} from '../../src/server/db/schema';
import {
  fetchAdminMeeting,
  fetchMeetingFor,
  fetchUpcomingOccasionsFor,
  fetchMemberLots,
  fetchMemberProxies,
} from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();
const TODAY = '2026-08-04';

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberVotes);
  await db.delete(memberAttendance);
  // proxies carries a proxy_id FK (NO ACTION) from memberAttendance/memberVotes
  // — those must be cleared first, same ordering proxy-flip.test.ts uses.
  await db.delete(proxies);
  await db.delete(elections);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
});

async function seedProperty(
  id: string,
  opts: { weight?: number; status?: 'active' | 'inactive' } = {},
) {
  await fx.seedProperty(id, {
    ...(opts.weight === undefined ? {} : { voteWeight: opts.weight }),
    ...(opts.status === undefined ? {} : { status: opts.status }),
  });
}

async function seedOwner(id: string, propertyId: string, fullName: string) {
  await fx.seedOwner(id, propertyId, { fullName });
}

async function seedMeeting(id: string, body: 'board' | 'member' = 'member') {
  await fx.seedMeeting(id, { body });
}

async function seedProxy(
  id: string,
  propertyId: string,
  meetingId: string,
  grantorOwnerId: string,
) {
  await getDb(env).insert(proxies).values({
    id,
    propertyId,
    grantorOwnerId,
    holderName: 'Jane Q. Holder',
    holderOwnerId: null,
    meetingId,
    electionId: null,
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
    });

    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.memberAttendance).toEqual([
      {
        propertyId: 'p1',
        address: 'p1 Ashebrook Lane',
        present: true,
        weight: 2,
        representedByName: null,
        viaProxy: false,
        proxyId: null,
      },
    ]);
  });

  it("resolves the representing owner's name, and leaves it null when absent", async () => {
    const db = getDb(env);
    await seedProperty('p1');
    await seedProperty('p2');
    await seedOwner('o1', 'p1', 'A. Reyes');
    await seedMeeting('m1');
    await seedProxy('px1', 'p1', 'm1', 'o1');
    await db.insert(memberAttendance).values([
      {
        id: 'a1',
        meetingId: 'm1',
        propertyId: 'p1',
        present: true,
        representedByOwnerId: 'o1',
        proxyId: 'px1',
      },
      {
        id: 'a2',
        meetingId: 'm1',
        propertyId: 'p2',
        present: true,
        representedByOwnerId: null,
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
    expect(byProperty.get('p1')?.proxyId).toBe('px1');
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
        weight: 3,
        choice: 'yes',
      },
      {
        id: 'v2',
        motionId: 'mo1',
        propertyId: 'p2',
        castByOwnerId: null,
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
        weight: 1,
        choice: 'yes',
      },
      {
        id: 'v2',
        motionId: 'mo2',
        propertyId: 'p2',
        castByOwnerId: null,
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
      },
      {
        id: 'a2',
        meetingId: 'm2',
        propertyId: 'p2',
        present: false,
        representedByOwnerId: null,
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
    });
    // seedMeeting always creates a 'draft' meeting — the member-assembly
    // additions in this file must not have loosened fetchMeetingFor's
    // status/tier gate, even though the meeting now has member rows to
    // assemble.
    expect(await fetchMeetingFor(env, 'board', 'm1')).toBeNull();
  });
});

// --- fetchUpcomingOccasionsFor / fetchMemberLots / fetchMemberProxies -----
// Distinct seed helpers below (seedOccasion*) — the "member meeting assembly"
// helpers above (seedProperty/seedOwner/seedMeeting/seedProxy) take different
// argument shapes and default to visibility: 'board', which would defeat the
// tier-filter tests here.

async function seedOccasionProperty(
  id: string,
  address: string,
  status = 'active',
) {
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address,
      addressNormalized: address.toLowerCase(),
      status: status as 'active' | 'inactive',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedOccasionOwner(
  id: string,
  propertyId: string,
  fullName: string,
  status = 'active',
) {
  await getDb(env)
    .insert(owners)
    .values({
      id,
      propertyId,
      fullName,
      status: status as 'active' | 'inactive',
      createdAt: now,
      updatedAt: now,
    });
}

async function seedOccasionMeeting(overrides: Record<string, unknown>) {
  const id = (overrides.id as string) ?? crypto.randomUUID();
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'member',
      kind: 'annual',
      date: '2026-09-01',
      title: 'Annual meeting',
      status: 'draft',
      visibility: 'homeowner',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

async function seedOccasionElection(overrides: Record<string, unknown>) {
  const id = (overrides.id as string) ?? crypto.randomUUID();
  await getDb(env)
    .insert(elections)
    .values({
      id,
      title: 'Board election',
      seats: 2,
      electionDate: '2026-10-01',
      source: 'recorded',
      status: 'draft',
      visibility: 'homeowner',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

async function seedOccasionProxy(overrides: Record<string, unknown>) {
  const id = (overrides.id as string) ?? crypto.randomUUID();
  await getDb(env)
    .insert(proxies)
    .values({
      id,
      propertyId: 'p1',
      grantorOwnerId: 'o1',
      holderName: 'Holder Name',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

describe('fetchUpcomingOccasionsFor', () => {
  it('returns future member meetings and non-terminal elections at the caller tier, sorted by date', async () => {
    await seedOccasionMeeting({
      id: 'm1',
      date: '2026-09-01',
      title: 'Annual',
    });
    await seedOccasionElection({ id: 'e1', electionDate: '2026-08-20' });
    const out = await fetchUpcomingOccasionsFor(env, 'homeowner', TODAY);
    expect(out.map((o) => o.id)).toEqual(['e1', 'm1']);
    expect(out[0]).toEqual({
      kind: 'election',
      id: 'e1',
      title: 'Board election',
      date: '2026-08-20',
      seats: 2,
    });
    expect(out[1].seats).toBeNull();
  });

  it('excludes board-body meetings, past occasions, and terminal elections', async () => {
    await seedOccasionMeeting({ id: 'mBoard', body: 'board' });
    await seedOccasionMeeting({ id: 'mPast', date: '2026-07-01' });
    await seedOccasionElection({ id: 'eClosed', status: 'closed' });
    await seedOccasionElection({ id: 'eVoid', status: 'void' });
    await seedOccasionElection({ id: 'ePast', electionDate: '2026-01-01' });
    const out = await fetchUpcomingOccasionsFor(env, 'homeowner', TODAY);
    expect(out).toEqual([]);
  });

  it('applies the visibility tier: board-only occasions hidden from homeowners, visible to board; today itself counts as upcoming', async () => {
    await seedOccasionMeeting({ id: 'mB', visibility: 'board', date: TODAY });
    expect(await fetchUpcomingOccasionsFor(env, 'homeowner', TODAY)).toEqual(
      [],
    );
    const forBoard = await fetchUpcomingOccasionsFor(env, 'board', TODAY);
    expect(forBoard.map((o) => o.id)).toEqual(['mB']);
  });

  it('includes a draft meeting the board published to the homeowner tier (positive control for the ADR 0019 narrowing)', async () => {
    await seedOccasionMeeting({
      id: 'mDraft',
      status: 'draft',
      visibility: 'homeowner',
    });
    const out = await fetchUpcomingOccasionsFor(env, 'homeowner', TODAY);
    expect(out.map((o) => o.id)).toEqual(['mDraft']);
  });
});

describe('fetchMemberLots', () => {
  it('returns the given active lots with their active owners only', async () => {
    await seedOccasionProperty('p1', '1 Ashebrook Lane');
    await seedOccasionProperty('p2', '2 Ashebrook Lane');
    await seedOccasionOwner('o1', 'p1', 'Jane Doe');
    await seedOccasionOwner('o2', 'p1', 'Old Owner', 'inactive');
    const out = await fetchMemberLots(env, ['p1']);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe('1 Ashebrook Lane');
    expect(out[0].owners).toEqual([{ id: 'o1', fullName: 'Jane Doe' }]);
  });

  it('returns [] for an empty id list', async () => {
    expect(await fetchMemberLots(env, [])).toEqual([]);
  });
});

describe('fetchMemberProxies', () => {
  it('splits granted (my lots) from held (naming me as holder), resolving occasion title and date', async () => {
    await seedOccasionProperty('p1', '1 Ashebrook Lane');
    await seedOccasionProperty('p2', '2 Ashebrook Lane');
    await seedOccasionOwner('o1', 'p1', 'Jane Doe');
    await seedOccasionOwner('o2', 'p2', 'John Roe');
    const m1 = await seedOccasionMeeting({ id: 'm1', title: 'Annual' });
    // Granted by my lot p1 to John (another lot's owner):
    await seedOccasionProxy({
      id: 'pxG',
      propertyId: 'p1',
      grantorOwnerId: 'o1',
      holderName: 'John Roe',
      holderOwnerId: 'o2',
      meetingId: m1,
    });
    // Held by me (o1 of p1) for John's lot p2:
    await seedOccasionProxy({
      id: 'pxH',
      propertyId: 'p2',
      grantorOwnerId: 'o2',
      holderName: 'Jane Doe',
      holderOwnerId: 'o1',
      meetingId: m1,
    });
    const out = await fetchMemberProxies(env, 'homeowner', ['p1']);
    expect(out.granted.map((p) => p.id)).toEqual(['pxG']);
    expect(out.granted[0].occasionTitle).toBe('Annual');
    expect(out.granted[0].occasionDate).toBe('2026-09-01');
    expect(out.held.map((p) => p.id)).toEqual(['pxH']);
    expect(out.held[0].address).toBe('2 Ashebrook Lane');
    expect(out.held[0].grantorName).toBe('John Roe');
  });

  it("never returns other lots' proxies and returns empty lists for no lots", async () => {
    await seedOccasionProperty('p1', '1 Ashebrook Lane');
    await seedOccasionProperty('p2', '2 Ashebrook Lane');
    await seedOccasionOwner('o1', 'p1', 'Jane Doe');
    await seedOccasionOwner('o2', 'p2', 'John Roe');
    const m1 = await seedOccasionMeeting({ id: 'm1' });
    await seedOccasionProxy({
      id: 'pxOther',
      propertyId: 'p2',
      grantorOwnerId: 'o2',
      holderName: 'Somebody Else',
      meetingId: m1,
    });
    const out = await fetchMemberProxies(env, 'homeowner', ['p1']);
    expect(out.granted).toEqual([]);
    expect(out.held).toEqual([]);
    expect(await fetchMemberProxies(env, 'homeowner', [])).toEqual({
      granted: [],
      held: [],
    });
  });
});
