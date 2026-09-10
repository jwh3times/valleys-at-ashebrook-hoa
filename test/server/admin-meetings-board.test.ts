import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/meetings';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  boardAttendance,
  boardPeople,
  motions,
  resolutions,
  elections,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import { legacyAuthContext } from '../../src/server/authz/context';
import { seedPeopleRows } from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(resolutions);
  await db.delete(elections);
  await db.delete(motions);
  await db.delete(boardAttendance);
  await db.delete(meetings);
  await db.delete(boardPeople);
});

const url = 'http://localhost/api/admin/meetings';

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
  const res = await POST(
    req(url, 'POST', {
      body: 'board',
      kind: 'regular',
      date: '2026-01-01',
      title: 'January meeting',
      ...overrides,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
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

async function createElectionFor(meetingId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await getDb(env).insert(elections).values({
    id,
    meetingId,
    title: '2026 Board Election',
    seats: 1,
    electionDate: '2026-03-01',
    source: 'recorded',
    status: 'draft',
    visibility: 'board',
    createdBy: 'b',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createMotion(meetingId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await getDb(env).insert(motions).values({
    id,
    meetingId,
    sequence: 1,
    text: 'Move to approve the prior meeting minutes',
    outcome: 'passed',
    createdBy: 'b',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('meetings admin route — board', () => {
  it('creates a board meeting and returns its id', async () => {
    const id = await createMeeting();
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows.length).toBe(1);
    expect(rows[0].body).toBe('board');
    expect(rows[0].status).toBe('draft');
    expect(rows[0].createdBy).toBe('b');
  });

  it('creates a member meeting', async () => {
    const id = await createMeeting({ body: 'member', kind: 'annual' });
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows[0].body).toBe('member');
    expect(rows[0].kind).toBe('annual');
  });

  it('rejects a create carrying status, with 400', async () => {
    const res = await POST(
      req(url, 'POST', {
        body: 'board',
        kind: 'regular',
        date: '2026-01-01',
        title: 'January meeting',
        status: 'approved',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('approve sets status, approvedAt, and approvedBy', async () => {
    const id = await createMeeting();
    const res = await POST(
      req(url, 'POST', { action: 'approve', meetingId: id }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows[0].status).toBe('approved');
    expect(rows[0].approvedAt).not.toBeNull();
    expect(rows[0].approvedBy).toBe('b');
  });

  it('approve rejects an unknown approving motion with 400', async () => {
    const id = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        action: 'approve',
        meetingId: id,
        approvedByMotionId: 'missing-motion',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/motion not found/i);
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows[0].status).toBe('draft');
    expect(rows[0].approvedByMotionId).toBeNull();
  });

  it('approve records a motion from a following meeting', async () => {
    const minutesMeetingId = await createMeeting({
      date: '2026-01-01',
      title: 'January meeting',
    });
    const approvingMeetingId = await createMeeting({
      date: '2026-02-01',
      title: 'February meeting',
    });
    const approvingMotionId = await createMotion(approvingMeetingId);

    const res = await POST(
      req(url, 'POST', {
        action: 'approve',
        meetingId: minutesMeetingId,
        approvedByMotionId: approvingMotionId,
      }),
    );

    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, minutesMeetingId));
    expect(rows[0].approvedByMotionId).toBe(approvingMotionId);
  });

  it('unapprove clears approvedAt and approvedBy, not just status', async () => {
    const id = await createMeeting();
    await POST(req(url, 'POST', { action: 'approve', meetingId: id }));
    const res = await POST(
      req(url, 'POST', { action: 'unapprove', meetingId: id }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows[0].status).toBe('draft');
    expect(rows[0].approvedAt).toBeNull();
    expect(rows[0].approvedBy).toBeNull();
    expect(rows[0].approvedByMotionId).toBeNull();
  });

  it('approving an already-approved meeting returns 409', async () => {
    const id = await createMeeting();
    await POST(req(url, 'POST', { action: 'approve', meetingId: id }));
    const res = await POST(
      req(url, 'POST', { action: 'approve', meetingId: id }),
    );
    expect(res.status).toBe(409);
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows[0].status).toBe('approved');
  });

  it('DELETE on an approved meeting returns 409 and the meeting survives', async () => {
    const id = await createMeeting();
    await POST(req(url, 'POST', { action: 'approve', meetingId: id }));
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows.length).toBe(1);
  });

  it('DELETE on a draft removes it and cascades its motions', async () => {
    const id = await createMeeting();
    const now = new Date();
    await getDb(env).insert(motions).values({
      id: crypto.randomUUID(),
      meetingId: id,
      sequence: 1,
      text: 'Move to approve the budget',
      outcome: 'passed',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const meetingRows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(meetingRows.length).toBe(0);
    const motionRows = await getDb(env)
      .select()
      .from(motions)
      .where(eq(motions.meetingId, id));
    expect(motionRows.length).toBe(0);
  });

  it('DELETE refuses a draft meeting whose motion is cited by a resolution, with 409, and both survive', async () => {
    const id = await createMeeting();
    const now = new Date();
    const motionId = crypto.randomUUID();
    await getDb(env).insert(motions).values({
      id: motionId,
      meetingId: id,
      sequence: 1,
      text: 'Move to adopt the resolution',
      outcome: 'passed',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const resolutionId = await createResolutionCiting(motionId);
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/cited as a resolution/i);
    const meetingRows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(meetingRows.length).toBe(1);
    const resolutionRows = await getDb(env)
      .select()
      .from(resolutions)
      .where(eq(resolutions.id, resolutionId));
    expect(resolutionRows[0].adoptedByMotionId).toBe(motionId);
  });

  it('DELETE refuses a draft meeting referenced by an election, with 409, and both survive', async () => {
    const id = await createMeeting();
    const electionId = await createElectionFor(id);
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/election/i);
    const meetingRows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(meetingRows.length).toBe(1);
    const electionRows = await getDb(env)
      .select()
      .from(elections)
      .where(eq(elections.id, electionId));
    expect(electionRows[0].meetingId).toBe(id);
  });

  it('DELETE still removes an unreferenced draft meeting with 204 (control for the election-citation guard)', async () => {
    // An election referencing a different meeting exists elsewhere, but this
    // meeting is unrelated — the guard must not be so broad that any
    // election's existence blocks deleting any meeting.
    const citedMeetingId = await createMeeting();
    await createElectionFor(citedMeetingId);

    const id = await createMeeting();
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const meetingRows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(meetingRows.length).toBe(0);
  });

  it('DELETE still removes an unrelated draft meeting with 204 (control for the resolution-citation guard)', async () => {
    // A meeting containing a motion cited by a resolution exists elsewhere,
    // but this meeting is unrelated — the guard must not be so broad that
    // any resolution's existence blocks deleting any meeting.
    const citedMeetingId = await createMeeting();
    const now = new Date();
    const citedMotionId = crypto.randomUUID();
    await getDb(env).insert(motions).values({
      id: citedMotionId,
      meetingId: citedMeetingId,
      sequence: 1,
      text: 'Move to adopt the resolution',
      outcome: 'passed',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    await createResolutionCiting(citedMotionId);

    const id = await createMeeting();
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const meetingRows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(meetingRows.length).toBe(0);
  });

  it('setAttendance replaces the whole set — an omitted person is removed', async () => {
    const id = await createMeeting();
    const p1 = await createPerson('A. Reyes');
    const p2 = await createPerson('B. Ortiz');
    const first = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [
          { personId: p1, present: true },
          { personId: p2, present: false },
        ],
      }),
    );
    expect(first.status).toBe(204);
    let rows = await getDb(env)
      .select()
      .from(boardAttendance)
      .where(eq(boardAttendance.meetingId, id));
    expect(rows.length).toBe(2);

    const second = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [{ personId: p1, present: true }],
      }),
    );
    expect(second.status).toBe(204);
    rows = await getDb(env)
      .select()
      .from(boardAttendance)
      .where(eq(boardAttendance.meetingId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].personId).toBe(p1);
  });

  it('setAttendance can clear attendance entirely', async () => {
    const id = await createMeeting();
    const p1 = await createPerson('A. Reyes');
    await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [{ personId: p1, present: true }],
      }),
    );
    const res = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(boardAttendance)
      .where(eq(boardAttendance.meetingId, id));
    expect(rows.length).toBe(0);
  });

  it('setAttendance on a nonexistent meeting returns 404', async () => {
    const p1 = await createPerson('A. Reyes');
    const res = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: 'nope',
        entries: [{ personId: p1, present: true }],
      }),
    );
    expect(res.status).toBe(404);
  });

  // #234: person_id is a NOT NULL FK to people(party_id), so an unknown id
  // used to reach D1 and come back as an unhandled 500 — which the panel
  // cannot tell from a genuine server fault. The member and ballot actions
  // already pre-checked their Person columns; this one did not.
  it('setAttendance with an unknown personId returns 400, not a raw 500', async () => {
    const id = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [{ personId: 'ghost', present: true }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown personId in entries');
    const rows = await getDb(env)
      .select()
      .from(boardAttendance)
      .where(eq(boardAttendance.meetingId, id));
    expect(rows.length).toBe(0);
  });

  it('setAttendance leaves the existing roll intact when one entry is unknown', async () => {
    const id = await createMeeting();
    const p1 = await createPerson('A. Reyes');
    const seeded = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [{ personId: p1, present: true }],
      }),
    );
    expect(seeded.status).toBe(204);

    const res = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [
          { personId: p1, present: false },
          { personId: 'ghost', present: true },
        ],
      }),
    );
    expect(res.status).toBe(400);
    // The guard runs before the delete, so the full replace never starts and
    // the previously recorded roll survives unchanged.
    const rows = await getDb(env)
      .select()
      .from(boardAttendance)
      .where(eq(boardAttendance.meetingId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].present).toBe(true);
  });

  it('setAttendance on a member-body meeting returns 409', async () => {
    const id = await createMeeting({ body: 'member', kind: 'annual' });
    const p1 = await createPerson('A. Reyes');
    const res = await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [{ personId: p1, present: true }],
      }),
    );
    expect(res.status).toBe(409);
    const rows = await getDb(env)
      .select()
      .from(boardAttendance)
      .where(eq(boardAttendance.meetingId, id));
    expect(rows.length).toBe(0);
  });

  it('PATCH cannot write status (400)', async () => {
    const id = await createMeeting();
    const res = await PATCH(req(url, 'PATCH', { id, status: 'approved' }));
    expect(res.status).toBe(400);
    const rows = await getDb(env)
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    expect(rows[0].status).toBe('draft');
  });

  it('PATCH on a nonexistent meeting returns 404', async () => {
    const res = await PATCH(
      req(url, 'PATCH', { id: 'nope', title: 'New title' }),
    );
    expect(res.status).toBe(404);
  });

  it('PATCH updates allowed fields and lists via GET', async () => {
    const id = await createMeeting();
    const res = await PATCH(
      req(url, 'PATCH', { id, title: 'Rescheduled meeting' }),
    );
    expect(res.status).toBe(204);
    const list = (await (await GET(req(url, 'GET'))).json()) as {
      id: string;
      title: string;
    }[];
    expect(list.find((m) => m.id === id)?.title).toBe('Rescheduled meeting');
  });

  it('GET ?id= returns the detail for a DRAFT meeting', async () => {
    const id = await createMeeting();
    const res = await GET(req(`${url}?id=${id}`, 'GET'));
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      id: string;
      status: string;
      motions: unknown[];
      attendance: unknown[];
    };
    expect(detail.id).toBe(id);
    expect(detail.status).toBe('draft');
    expect(detail.motions).toEqual([]);
    expect(detail.attendance).toEqual([]);
  });

  it('GET ?id= nests a meeting motions, attendance, and votes', async () => {
    const id = await createMeeting();
    const p1 = await createPerson('A. Reyes');
    await POST(
      req(url, 'POST', {
        action: 'setAttendance',
        meetingId: id,
        entries: [{ personId: p1, present: true }],
      }),
    );
    const now = new Date();
    await getDb(env).insert(motions).values({
      id: crypto.randomUUID(),
      meetingId: id,
      sequence: 1,
      text: 'Move to approve the budget',
      moverPersonId: p1,
      outcome: 'passed',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const res = await GET(req(`${url}?id=${id}`, 'GET'));
    const detail = (await res.json()) as {
      motions: { text: string; moverName: string | null }[];
      attendance: { fullName: string; present: boolean }[];
    };
    expect(detail.motions).toHaveLength(1);
    expect(detail.motions[0].text).toBe('Move to approve the budget');
    expect(detail.motions[0].moverName).toBe('A. Reyes');
    expect(detail.attendance).toEqual([
      { personId: p1, fullName: 'A. Reyes', present: true },
    ]);
  });

  it('GET ?id= for an unknown meeting returns 404', async () => {
    const res = await GET(req(`${url}?id=nope`, 'GET'));
    expect(res.status).toBe(404);
  });

  // #237: the flat archive-wide motions read that replaced the Resolutions
  // panel's 1+N client-side fan-out.
  describe('GET ?motions=all', () => {
    async function seedMotion(
      meetingId: string,
      sequence: number,
      text: string,
    ) {
      const now = new Date();
      await getDb(env).insert(motions).values({
        id: crypto.randomUUID(),
        meetingId,
        sequence,
        text,
        outcome: 'passed',
        createdBy: 'b',
        createdAt: now,
        updatedAt: now,
      });
    }

    it('returns an empty list when no motion has been recorded', async () => {
      await createMeeting();
      const res = await GET(req(`${url}?motions=all`, 'GET'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    // The order the picker relies on, and the order the fan-out it replaced
    // produced: newest meeting first, then each meeting's motions in the
    // sequence they were recorded in.
    it('orders newest meeting first, then by motion sequence', async () => {
      const older = await createMeeting({ date: '2026-01-01' });
      const newer = await createMeeting({ date: '2026-03-01' });
      await seedMotion(older, 1, 'January first motion');
      await seedMotion(newer, 2, 'March second motion');
      await seedMotion(newer, 1, 'March first motion');

      const res = await GET(req(`${url}?motions=all`, 'GET'));
      expect(res.status).toBe(200);
      const rows = (await res.json()) as {
        meetingId: string;
        date: string;
        sequence: number;
        text: string;
      }[];
      expect(rows.map((r) => r.text)).toEqual([
        'March first motion',
        'March second motion',
        'January first motion',
      ]);
      expect(rows[0]).toEqual(
        expect.objectContaining({ meetingId: newer, date: '2026-03-01' }),
      );
    });

    // The design question this branch turns on. The Resolutions panel needs
    // to cite the motion that adopted a resolution, and that motion is
    // routinely recorded in minutes still in draft — so the list spans every
    // status and tier rather than filtering the way the public reads do. It
    // is safe because the route is requireBoard-gated and `board` is the top
    // tier; the fan-out this replaced went through fetchAdminMeeting and
    // offered exactly the same set.
    it('includes motions from draft and board-tier meetings, not only approved public ones', async () => {
      const draft = await createMeeting({ date: '2026-02-01' });
      const approved = await createMeeting({
        date: '2026-02-02',
        visibility: 'public',
      });
      await seedMotion(draft, 1, 'Motion in a draft board-tier meeting');
      await seedMotion(approved, 1, 'Motion in an approved public meeting');
      expect(
        (
          await POST(
            req(url, 'POST', { action: 'approve', meetingId: approved }),
          )
        ).status,
      ).toBe(204);

      const res = await GET(req(`${url}?motions=all`, 'GET'));
      const rows = (await res.json()) as { text: string }[];
      expect(rows.map((r) => r.text)).toEqual([
        'Motion in an approved public meeting',
        'Motion in a draft board-tier meeting',
      ]);
    });

    // Two meetings on the same day is the ordinary case — the annual member
    // meeting and the board meeting around it — so `date` alone does not
    // settle the order. The createdAt tiebreak is what makes the "same order
    // the fan-out produced" claim true there, and without this test it could
    // be deleted silently.
    //
    // The two createdAt values are stamped a minute apart rather than left to
    // the route's own `new Date()`. That column is second-granularity, so two
    // meetings created in the same second tie on BOTH sort keys and SQLite is
    // free to return them either way — true of `fetchAdminMeetings` since it
    // was written, and not something this branch changes. Controlling the
    // timestamps is what makes the assertion about the tiebreak instead of
    // about how fast the test ran.
    it('breaks a same-date tie by which meeting was recorded later', async () => {
      const db = getDb(env);
      const earlier = crypto.randomUUID();
      const later = crypto.randomUUID();
      const base = new Date('2026-04-01T18:00:00Z');
      for (const [id, createdAt] of [
        [earlier, base],
        [later, new Date(base.getTime() + 60_000)],
      ] as const) {
        await db.insert(meetings).values({
          id,
          body: 'board',
          kind: 'regular',
          date: '2026-04-01',
          title: 'April meeting',
          createdBy: 'b',
          createdAt,
          updatedAt: createdAt,
        });
      }
      await seedMotion(earlier, 1, 'Motion in the earlier-recorded meeting');
      await seedMotion(later, 1, 'Motion in the later-recorded meeting');

      const res = await GET(req(`${url}?motions=all`, 'GET'));
      const rows = (await res.json()) as { text: string }[];
      expect(rows.map((r) => r.text)).toEqual([
        'Motion in the later-recorded meeting',
        'Motion in the earlier-recorded meeting',
      ]);
    });

    // The picker labels every option "date — text", so the parent meeting's
    // date has to ride along; without it the caller is back to fetching the
    // meeting list to re-join client-side, which is the cost this removed.
    it('carries the parent meeting date on every row', async () => {
      const id = await createMeeting({ date: '2026-05-04' });
      await seedMotion(id, 1, 'Move to adopt Resolution 2026-1');
      const res = await GET(req(`${url}?motions=all`, 'GET'));
      const rows = (await res.json()) as { date: string; id: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe('2026-05-04');
      expect(rows[0].id).toBeTruthy();
    });
  });
});
