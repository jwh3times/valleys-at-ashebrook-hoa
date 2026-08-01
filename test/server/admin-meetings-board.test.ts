import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/meetings';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  boardAttendance,
  boardPeople,
  motions,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
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
  await getDb(env)
    .insert(boardPeople)
    .values({ id, fullName, userId: null, createdAt: now, updatedAt: now });
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
});
