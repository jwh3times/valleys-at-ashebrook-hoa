import { env, applyD1Migrations } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import * as fx from './fixtures';
import {
  meetings,
  motions,
  motionEligibility,
  boardVotes,
  boardAttendance,
  boardPeople,
  properties,
} from '../../src/server/db/schema';
import {
  fetchMeetingsFor,
  fetchMeetingFor,
  fetchAdminMeetings,
  fetchAdminMeeting,
} from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(fx.truncateAll);

async function seed(
  id: string,
  status: 'draft' | 'approved',
  visibility: 'public' | 'homeowner' | 'board',
  date = '2026-09-14',
) {
  // Board body is stated, not inherited: the column decides which voter
  // model applies, and this suite is about the board record.
  await fx.seedMeeting(id, {
    body: 'board',
    kind: 'regular',
    date,
    title: `T-${id}`,
    status,
    visibility,
  });
}

describe('meeting read helpers', () => {
  it('hides drafts from a visitor', async () => {
    await seed('m1', 'draft', 'public');
    expect((await fetchMeetingsFor(env, 'visitor')).length).toBe(0);
  });

  it('hides drafts from a BOARD caller too', async () => {
    await seed('m1', 'draft', 'board');
    await seed('m2', 'approved', 'board');
    const rows = await fetchMeetingsFor(env, 'board');
    expect(rows.map((r) => r.id)).toEqual(['m2']);
  });

  it('applies the visibility tier to approved meetings', async () => {
    await seed('pub', 'approved', 'public');
    await seed('ho', 'approved', 'homeowner');
    await seed('bd', 'approved', 'board');
    expect((await fetchMeetingsFor(env, 'visitor')).map((r) => r.id)).toEqual([
      'pub',
    ]);
    expect(
      (await fetchMeetingsFor(env, 'homeowner')).map((r) => r.id).sort(),
    ).toEqual(['ho', 'pub']);
    expect((await fetchMeetingsFor(env, 'board')).length).toBe(3);
  });

  it('orders newest first', async () => {
    await seed('old', 'approved', 'public', '2026-01-01');
    await seed('new', 'approved', 'public', '2026-12-31');
    expect((await fetchMeetingsFor(env, 'visitor')).map((r) => r.id)).toEqual([
      'new',
      'old',
    ]);
  });

  it('returns null from the detail read for a draft, even for board', async () => {
    await seed('m1', 'draft', 'board');
    expect(await fetchMeetingFor(env, 'board', 'm1')).toBeNull();
  });

  it('returns null from the detail read for an out-of-tier meeting', async () => {
    await seed('m1', 'approved', 'board');
    expect(await fetchMeetingFor(env, 'homeowner', 'm1')).toBeNull();
  });

  it('nests attendance and motions with derived tallies', async () => {
    const db = getDb(env);
    await db.insert(boardPeople).values([
      {
        id: 'p1',
        fullName: 'A. Reyes',
        userId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'p2',
        fullName: 'B. Ortiz',
        userId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await seed('m1', 'approved', 'public');
    await db.insert(boardAttendance).values([
      { id: 'a1', meetingId: 'm1', personId: 'p1', present: true },
      { id: 'a2', meetingId: 'm1', personId: 'p2', present: false },
    ]);
    await db.insert(motions).values([
      {
        id: 'mo2',
        meetingId: 'm1',
        sequence: 2,
        text: 'Second motion',
        moverPersonId: 'p2',
        secondPersonId: null,
        outcome: 'failed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'mo1',
        meetingId: 'm1',
        sequence: 1,
        text: 'First motion',
        moverPersonId: 'p1',
        secondPersonId: 'p2',
        outcome: 'passed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(boardVotes).values([
      { id: 'v1', motionId: 'mo1', personId: 'p1', choice: 'yes' },
      { id: 'v2', motionId: 'mo1', personId: 'p2', choice: 'no' },
    ]);

    const detail = await fetchMeetingFor(env, 'visitor', 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    // Sequence order, not insertion order.
    expect(detail.motions.map((m) => m.sequence)).toEqual([1, 2]);
    expect(detail.motions[0].moverName).toBe('A. Reyes');
    expect(detail.motions[0].secondName).toBe('B. Ortiz');
    expect(detail.motions[0].tally).toEqual({
      yes: 1,
      no: 1,
      abstain: 0,
      recused: 0,
      absent: 0,
      recorded: true,
    });
    // A motion with no roll call must not look like a 0-0 vote.
    expect(detail.motions[1].tally.recorded).toBe(false);
    expect(detail.attendance.map((a) => a.fullName).sort()).toEqual([
      'A. Reyes',
      'B. Ortiz',
    ]);
    expect(detail.motions[0].votes.map((v) => v.fullName).sort()).toEqual([
      'A. Reyes',
      'B. Ortiz',
    ]);
  });

  it('uses frozen motion eligibility while never-opened motions use the current roster', async () => {
    const db = getDb(env);
    await db.insert(properties).values([
      {
        id: 'property-a',
        address: '1 Ashebrook Lane',
        addressNormalized: '1 ashebrook lane',
        status: 'active',
        voteWeight: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'property-b',
        address: '2 Ashebrook Lane',
        addressNormalized: '2 ashebrook lane',
        status: 'active',
        voteWeight: 2,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await getDb(env).insert(meetings).values({
      id: 'member-meeting',
      body: 'member',
      kind: 'regular',
      date: '2026-09-14',
      title: 'Member meeting',
      status: 'approved',
      visibility: 'public',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(motions).values([
      {
        id: 'frozen-motion',
        meetingId: 'member-meeting',
        sequence: 1,
        text: 'Previously opened motion',
        moverPersonId: null,
        secondPersonId: null,
        votingState: 'closed',
        outcome: 'passed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'never-opened-motion',
        meetingId: 'member-meeting',
        sequence: 2,
        text: 'Never opened motion',
        moverPersonId: null,
        secondPersonId: null,
        votingState: 'none',
        outcome: 'tabled',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(motionEligibility).values([
      {
        motionId: 'frozen-motion',
        propertyId: 'property-a',
        weight: 1,
      },
      {
        motionId: 'frozen-motion',
        propertyId: 'property-b',
        weight: 2,
      },
    ]);

    // The current roster now totals one active lot and weight 11.
    await db
      .update(properties)
      .set({ voteWeight: 11 })
      .where(eq(properties.id, 'property-a'));
    await db
      .update(properties)
      .set({ voteWeight: 22, status: 'inactive' })
      .where(eq(properties.id, 'property-b'));

    const detail = await fetchMeetingFor(env, 'visitor', 'member-meeting');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.motions[0]).toMatchObject({
      id: 'frozen-motion',
      votingState: 'closed',
      eligibleCount: 2,
      eligibleWeight: 3,
      eligibilityFrozen: true,
    });
    expect(detail.motions[1]).toMatchObject({
      id: 'never-opened-motion',
      votingState: 'none',
      eligibleCount: 1,
      eligibleWeight: 11,
      eligibilityFrozen: false,
    });
  });

  it('scopes attendance and motions to the requested meeting only', async () => {
    const db = getDb(env);
    await db.insert(boardPeople).values([
      {
        id: 'p1',
        fullName: 'A. Reyes',
        userId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'p2',
        fullName: 'B. Ortiz',
        userId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await seed('m1', 'approved', 'public');
    // A second meeting, deliberately draft/board — the failure mode that
    // matters is a public detail read splicing in a private meeting's data.
    await seed('m2', 'draft', 'board');

    await db.insert(boardAttendance).values([
      { id: 'a1', meetingId: 'm1', personId: 'p1', present: true },
      { id: 'a2', meetingId: 'm2', personId: 'p2', present: false },
    ]);
    await db.insert(motions).values([
      {
        id: 'm1-mo',
        meetingId: 'm1',
        sequence: 1,
        text: 'm1 motion',
        moverPersonId: 'p1',
        secondPersonId: null,
        outcome: 'passed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'm2-mo',
        meetingId: 'm2',
        sequence: 1,
        text: 'm2 motion (draft)',
        moverPersonId: 'p2',
        secondPersonId: null,
        outcome: 'passed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(boardVotes).values([
      { id: 'v1', motionId: 'm1-mo', personId: 'p1', choice: 'yes' },
      { id: 'v2', motionId: 'm2-mo', personId: 'p2', choice: 'no' },
    ]);

    const detail = await fetchMeetingFor(env, 'visitor', 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.motions.map((m) => m.id)).toEqual(['m1-mo']);
    expect(detail.motions.map((m) => m.text)).toEqual(['m1 motion']);
    expect(detail.attendance.map((a) => a.personId)).toEqual(['p1']);
    // The draft meeting's "no" vote must not appear in m1's tally.
    expect(detail.motions[0].tally).toEqual({
      yes: 1,
      no: 0,
      abstain: 0,
      recused: 0,
      absent: 0,
      recorded: true,
    });
  });

  it('returns an empty motions array for a meeting with no motions', async () => {
    const db = getDb(env);
    await db.insert(boardPeople).values({
      id: 'p1',
      fullName: 'A. Reyes',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });
    await seed('m1', 'approved', 'public');
    await db.insert(boardAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      personId: 'p1',
      present: true,
    });

    // No motions inserted at all — this must not throw when the vote query's
    // empty-motions guard is exercised for real, not just read as correct.
    const detail = await fetchMeetingFor(env, 'visitor', 'm1');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.motions).toEqual([]);
    expect(detail.motionCount).toBe(0);
    expect(detail.attendance.map((a) => a.fullName)).toEqual(['A. Reyes']);
  });

  it('counts motions on the summary read', async () => {
    const db = getDb(env);
    await seed('m1', 'approved', 'public', '2026-09-14');
    await seed('m2', 'approved', 'public', '2026-01-01');
    await seed('m3', 'approved', 'public', '2026-02-01');
    await db.insert(motions).values([
      {
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
      },
      {
        id: 'mo2',
        meetingId: 'm1',
        sequence: 2,
        text: 'Y',
        moverPersonId: null,
        secondPersonId: null,
        outcome: 'passed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'mo3',
        meetingId: 'm2',
        sequence: 1,
        text: 'Z',
        moverPersonId: null,
        secondPersonId: null,
        outcome: 'passed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const rows = await fetchMeetingsFor(env, 'visitor');
    const byId = new Map(rows.map((r) => [r.id, r.motionCount]));
    expect(byId.get('m1')).toBe(2);
    expect(byId.get('m2')).toBe(1);
    expect(byId.get('m3')).toBe(0);
  });

  it('reads a meeting archive larger than the D1 bound-parameter limit', async () => {
    // The motion-count read binds one parameter per approved in-tier meeting.
    // Past D1's limit this failed outright — and it backs the PUBLIC /meetings
    // page, so the archive growing was enough to break it for everyone.
    for (let index = 0; index < 101; index += 1) {
      await seed(
        `archive-${index.toString().padStart(3, '0')}`,
        'approved',
        'public',
      );
    }
    // One meeting carries a motion, so a dropped batch shows up as a wrong
    // count rather than only as an absent row.
    await getDb(env).insert(motions).values({
      id: 'mo1',
      meetingId: 'archive-100',
      sequence: 1,
      text: 'X',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });

    const rows = await fetchMeetingsFor(env, 'visitor');

    expect(rows).toHaveLength(101);
    const byId = new Map(rows.map((r) => [r.id, r.motionCount]));
    expect(byId.get('archive-100')).toBe(1);
    expect(byId.get('archive-000')).toBe(0);
  });

  it('shows drafts to the admin read', async () => {
    await seed('m1', 'draft', 'board');
    await seed('m2', 'approved', 'public');
    expect((await fetchAdminMeetings(env)).map((r) => r.id).sort()).toEqual([
      'm1',
      'm2',
    ]);
  });

  describe('fetchAdminMeeting', () => {
    it('returns a DRAFT meeting — the whole point of the admin read', async () => {
      await seed('m1', 'draft', 'board');
      const detail = await fetchAdminMeeting(env, 'm1');
      expect(detail).not.toBeNull();
      expect(detail?.status).toBe('draft');
    });

    it('returns a board-visibility meeting regardless of status', async () => {
      await seed('m1', 'approved', 'board');
      const detail = await fetchAdminMeeting(env, 'm1');
      expect(detail).not.toBeNull();
      expect(detail?.visibility).toBe('board');
    });

    it('returns null for an unknown id', async () => {
      expect(await fetchAdminMeeting(env, 'nope')).toBeNull();
    });

    it('nests motions, attendance, and votes with derived tallies', async () => {
      const db = getDb(env);
      await db.insert(boardPeople).values([
        {
          id: 'p1',
          fullName: 'A. Reyes',
          userId: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'p2',
          fullName: 'B. Ortiz',
          userId: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await seed('m1', 'draft', 'board');
      await db.insert(boardAttendance).values([
        { id: 'a1', meetingId: 'm1', personId: 'p1', present: true },
        { id: 'a2', meetingId: 'm1', personId: 'p2', present: false },
      ]);
      await db.insert(motions).values({
        id: 'mo1',
        meetingId: 'm1',
        sequence: 1,
        text: 'First motion',
        moverPersonId: 'p1',
        secondPersonId: 'p2',
        outcome: 'passed',
        createdBy: 'u1',
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(boardVotes).values([
        { id: 'v1', motionId: 'mo1', personId: 'p1', choice: 'yes' },
        { id: 'v2', motionId: 'mo1', personId: 'p2', choice: 'no' },
      ]);

      const detail = await fetchAdminMeeting(env, 'm1');
      expect(detail).not.toBeNull();
      if (!detail) return;
      expect(detail.motions[0].moverName).toBe('A. Reyes');
      expect(detail.motions[0].secondName).toBe('B. Ortiz');
      expect(detail.motions[0].tally).toEqual({
        yes: 1,
        no: 1,
        abstain: 0,
        recused: 0,
        absent: 0,
        recorded: true,
      });
      expect(detail.attendance.map((a) => a.fullName).sort()).toEqual([
        'A. Reyes',
        'B. Ortiz',
      ]);
    });
  });

  // The shared-assembly extraction behind fetchMeetingFor/fetchAdminMeeting is
  // exactly the kind of refactor that could leak the public gate — this must
  // keep failing a draft/board-tier request after that change, not just once
  // before it.
  it('fetchMeetingFor still hides drafts after the shared-assembly refactor', async () => {
    await seed('m1', 'draft', 'board');
    expect(await fetchMeetingFor(env, 'board', 'm1')).toBeNull();
  });
});
