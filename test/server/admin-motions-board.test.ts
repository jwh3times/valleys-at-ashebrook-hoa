import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { POST, PATCH, DELETE } from '../../src/pages/api/admin/motions';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  motions,
  boardVotes,
  boardPeople,
  resolutions,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import { legacyAuthContext } from '../../src/server/authz/context';
import { seedPeopleRows } from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(boardVotes);
  await db.delete(resolutions);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(boardPeople);
});

const url = 'http://localhost/api/admin/motions';

function req(u: string, method: string, body?: unknown) {
  return {
    request: new Request(u, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

async function createMeeting(overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const now = new Date();
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'board',
      kind: 'regular',
      date: '2026-01-01',
      title: 'January meeting',
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

async function createPerson(fullName: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await seedPeopleRows({
    id,
    fullName,
    userId: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createMotion(
  meetingId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await POST(
    req(url, 'POST', {
      meetingId,
      text: 'Move to approve the budget',
      outcome: 'passed',
      ...overrides,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function createResolutionCiting(
  motionId: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await getDb(env)
    .insert(resolutions)
    .values({
      id,
      number: `R-${id.slice(0, 8)}`,
      title: 'Pool hours',
      bodyMd: 'The pool is open 9am to 9pm.',
      status: motionId ? 'in_force' : 'draft',
      effectiveDate: motionId ? '2026-01-01' : null,
      adoptedByMotionId: motionId,
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

describe('motions admin route — board', () => {
  it('creates a motion and assigns sequence 1, then 2, then 3', async () => {
    const meetingId = await createMeeting();
    const id1 = await createMotion(meetingId);
    const id2 = await createMotion(meetingId);
    const id3 = await createMotion(meetingId);
    const rows = await getDb(env)
      .select()
      .from(motions)
      .where(eq(motions.meetingId, meetingId));
    const bySeq = Object.fromEntries(rows.map((r) => [r.id, r.sequence]));
    expect(bySeq[id1]).toBe(1);
    expect(bySeq[id2]).toBe(2);
    expect(bySeq[id3]).toBe(3);
  });

  it('scopes sequence numbering per meeting, not globally', async () => {
    const meetingA = await createMeeting();
    const meetingB = await createMeeting({ title: 'February meeting' });
    const a1 = await createMotion(meetingA);
    const b1 = await createMotion(meetingB);
    const a2 = await createMotion(meetingA);
    const rows = await getDb(env).select().from(motions);
    const bySeq = Object.fromEntries(rows.map((r) => [r.id, r.sequence]));
    expect(bySeq[a1]).toBe(1);
    expect(bySeq[a2]).toBe(2);
    expect(bySeq[b1]).toBe(1);
  });

  it('creating against a nonexistent meeting returns 404', async () => {
    const res = await POST(
      req(url, 'POST', {
        meetingId: 'nope',
        text: 'Move to approve the budget',
        outcome: 'passed',
      }),
    );
    expect(res.status).toBe(404);
  });

  it('rejects a create carrying sequence, with 400', async () => {
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        meetingId,
        text: 'Move to approve the budget',
        outcome: 'passed',
        sequence: 5,
      }),
    );
    expect(res.status).toBe(400);
  });

  it('PATCH updates text and outcome', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const res = await PATCH(
      req(url, 'PATCH', {
        id,
        text: 'Move to approve the amended budget',
        outcome: 'tabled',
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(motions)
      .where(eq(motions.id, id));
    expect(rows[0].text).toBe('Move to approve the amended budget');
    expect(rows[0].outcome).toBe('tabled');
  });

  it('PATCH cannot move a motion to another meeting', async () => {
    const meetingId1 = await createMeeting();
    const meetingId2 = await createMeeting({ title: 'February meeting' });
    const id = await createMotion(meetingId1);
    const res = await PATCH(
      req(url, 'PATCH', { id, meetingId: meetingId2, text: 'Still here' }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(motions)
      .where(eq(motions.id, id));
    expect(rows[0].meetingId).toBe(meetingId1);
    expect(rows[0].text).toBe('Still here');
  });

  it('PATCH on a nonexistent motion returns 404', async () => {
    const res = await PATCH(req(url, 'PATCH', { id: 'nope', text: 'X' }));
    expect(res.status).toBe(404);
  });

  it('setVotes records one row per person', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createPerson('A. Reyes');
    const p2 = await createPerson('B. Ortiz');
    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [
          { personId: p1, choice: 'yes' },
          { personId: p2, choice: 'no' },
        ],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(rows.length).toBe(2);
  });

  it('setVotes replaces the whole roll call — an omitted person is removed', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createPerson('A. Reyes');
    const p2 = await createPerson('B. Ortiz');
    await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [
          { personId: p1, choice: 'yes' },
          { personId: p2, choice: 'no' },
        ],
      }),
    );
    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [{ personId: p1, choice: 'abstain' }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].personId).toBe(p1);
    expect(rows[0].choice).toBe('abstain');
  });

  it('setVotes with an empty list clears the roll call', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createPerson('A. Reyes');
    await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [{ personId: p1, choice: 'yes' }],
      }),
    );
    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  // #234, the sibling of setAttendance's hole: board_votes.person_id is a
  // NOT NULL FK to people(party_id) and was reaching D1 unchecked.
  it('setVotes with an unknown personId returns 400, not a raw 500', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [{ personId: 'ghost', choice: 'yes' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown personId in entries');
    const rows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('setVotes leaves the existing roll call intact when one entry is unknown', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createPerson('A. Reyes');
    const seeded = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [{ personId: p1, choice: 'yes' }],
      }),
    );
    expect(seeded.status).toBe(204);

    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [
          { personId: p1, choice: 'no' },
          { personId: 'ghost', choice: 'yes' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const rows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].choice).toBe('yes');
  });

  it('setVotes rejects an invalid choice with 400 and writes nothing', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createPerson('A. Reyes');
    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [{ personId: p1, choice: 'maybe' }],
      }),
    );
    expect(res.status).toBe(400);
    const rows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('setVotes on a nonexistent motion returns 404', async () => {
    const p1 = await createPerson('A. Reyes');
    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: 'nope',
        entries: [{ personId: p1, choice: 'yes' }],
      }),
    );
    expect(res.status).toBe(404);
  });

  it('setVotes on a member-body meeting returns 409 and writes nothing', async () => {
    const meetingId = await createMeeting({ body: 'member', kind: 'annual' });
    const id = await createMotion(meetingId);
    const p1 = await createPerson('A. Reyes');
    const res = await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [{ personId: p1, choice: 'yes' }],
      }),
    );
    expect(res.status).toBe(409);
    const rows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('DELETE removes the motion and cascades its votes', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createPerson('A. Reyes');
    await POST(
      req(url, 'POST', {
        action: 'setVotes',
        motionId: id,
        entries: [{ personId: p1, choice: 'yes' }],
      }),
    );
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const motionRows = await getDb(env)
      .select()
      .from(motions)
      .where(eq(motions.id, id));
    expect(motionRows.length).toBe(0);
    const voteRows = await getDb(env)
      .select()
      .from(boardVotes)
      .where(eq(boardVotes.motionId, id));
    expect(voteRows.length).toBe(0);
  });

  it('DELETE refuses a motion cited by a resolution, with 409, and the motion survives', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const resolutionId = await createResolutionCiting(id);
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/cited as a resolution/i);
    const motionRows = await getDb(env)
      .select()
      .from(motions)
      .where(eq(motions.id, id));
    expect(motionRows.length).toBe(1);
    const resolutionRows = await getDb(env)
      .select()
      .from(resolutions)
      .where(eq(resolutions.id, resolutionId));
    expect(resolutionRows[0].adoptedByMotionId).toBe(id);
  });

  it('DELETE still removes an uncited motion with 204 (control for the resolution-citation guard)', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    // An unrelated resolution exists but does not cite this motion — the
    // guard must not be so broad that any resolution's existence blocks
    // deletion.
    await createResolutionCiting(null);
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const motionRows = await getDb(env)
      .select()
      .from(motions)
      .where(eq(motions.id, id));
    expect(motionRows.length).toBe(0);
  });
});
