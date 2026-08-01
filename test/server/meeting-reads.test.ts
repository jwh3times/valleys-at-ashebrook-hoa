import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  motions,
  boardVotes,
  boardAttendance,
  boardPeople,
} from '../../src/server/db/schema';
import {
  fetchMeetingsFor,
  fetchMeetingFor,
  fetchAdminMeetings,
} from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(boardVotes);
  await db.delete(motions);
  await db.delete(boardAttendance);
  await db.delete(meetings);
  await db.delete(boardPeople);
});

async function seed(
  id: string,
  status: 'draft' | 'approved',
  visibility: 'public' | 'homeowner' | 'board',
  date = '2026-09-14',
) {
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'board',
      kind: 'regular',
      date,
      title: `T-${id}`,
      status,
      visibility,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
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

  it('shows drafts to the admin read', async () => {
    await seed('m1', 'draft', 'board');
    await seed('m2', 'approved', 'public');
    expect((await fetchAdminMeetings(env)).map((r) => r.id).sort()).toEqual([
      'm1',
      'm2',
    ]);
  });
});
