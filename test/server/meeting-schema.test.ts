import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  boardAttendance,
  motions,
  boardVotes,
  boardPeople,
} from '../../src/server/db/schema';
import {
  now,
  truncateAll,
  seedBoardPerson as seedPerson,
  seedMeeting as seedMeetingRow,
} from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(truncateAll);

// This suite is about the BOARD meeting record, so body is stated rather than
// inherited, and `kind` stays 'regular' to match the rows these tests assert on.
async function seedMeeting(id: string, body: 'board' | 'member' = 'board') {
  await seedMeetingRow(id, {
    body,
    kind: 'regular',
    title: 'September meeting',
  });
}

describe('meeting schema', () => {
  it('defaults a new meeting to draft and board visibility', async () => {
    await seedMeeting('m1');
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, 'm1'));
    expect(rows[0].status).toBe('draft');
    expect(rows[0].visibility).toBe('board');
    expect(rows[0].approvedAt).toBeNull();
    expect(rows[0].summaryMd).toBeNull();
  });

  it('accepts both body values so PR 3 needs no migration', async () => {
    await seedMeeting('m1', 'board');
    await seedMeeting('m2', 'member');
    const rows = await getDb(env).select().from(meetings);
    expect(rows.map((r) => r.body).sort()).toEqual(['board', 'member']);
  });

  it('cascades attendance, motions, and votes when a meeting is deleted', async () => {
    const db = getDb(env);
    await seedPerson('p1');
    await seedMeeting('m1');
    await db.insert(boardAttendance).values({
      id: 'a1',
      meetingId: 'm1',
      personId: 'p1',
      present: true,
    });
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'Adopt the budget',
      moverPersonId: 'p1',
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(boardVotes).values({
      id: 'v1',
      motionId: 'mo1',
      personId: 'p1',
      choice: 'yes',
    });

    await db.delete(meetings).where(eq(meetings.id, 'm1'));

    expect((await db.select().from(boardAttendance)).length).toBe(0);
    expect((await db.select().from(motions)).length).toBe(0);
    expect((await db.select().from(boardVotes)).length).toBe(0);
  });

  it('refuses to delete a person who has voted', async () => {
    const db = getDb(env);
    await seedPerson('p1');
    await seedMeeting('m1');
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: 'p1',
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(boardVotes).values({
      id: 'v1',
      motionId: 'mo1',
      personId: 'p1',
      choice: 'yes',
    });
    await expect(
      db.delete(boardPeople).where(eq(boardPeople.id, 'p1')),
    ).rejects.toThrow();
    expect((await db.select().from(boardPeople)).length).toBe(1);
  });

  it('rejects a second vote from the same person on one motion', async () => {
    const db = getDb(env);
    await seedPerson('p1');
    await seedMeeting('m1');
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'X',
      moverPersonId: 'p1',
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(boardVotes).values({
      id: 'v1',
      motionId: 'mo1',
      personId: 'p1',
      choice: 'yes',
    });
    await expect(
      db.insert(boardVotes).values({
        id: 'v2',
        motionId: 'mo1',
        personId: 'p1',
        choice: 'no',
      }),
    ).rejects.toThrow();
  });

  it('rejects two motions at the same sequence in one meeting', async () => {
    const db = getDb(env);
    await seedPerson('p1');
    await seedMeeting('m1');
    const base = {
      meetingId: 'm1',
      sequence: 1,
      moverPersonId: 'p1',
      secondPersonId: null,
      outcome: 'passed' as const,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(motions).values({ id: 'mo1', text: 'A', ...base });
    await expect(
      db.insert(motions).values({ id: 'mo2', text: 'B', ...base }),
    ).rejects.toThrow();
  });

  it('defaults a motion voting state to none', async () => {
    const cols = await getDb(env).run(sql`PRAGMA table_info(motions)`);
    const motionVotingState = cols.results.find(
      (column) => (column as Record<string, unknown>).name === 'voting_state',
    ) as Record<string, unknown> | undefined;

    expect(motionVotingState).toBeDefined();
    expect(motionVotingState?.notnull).toBe(1);
    expect(motionVotingState?.dflt_value).toBe("'none'");
  });
});
