import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST } from '../../src/pages/api/admin/meetings';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  memberAttendance,
  properties,
  owners,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberAttendance);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
});

const url = 'http://localhost/api/admin/meetings';
const now = new Date();

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
      body: 'member',
      kind: 'annual',
      date: '2026-01-01',
      title: 'Annual meeting',
      ...overrides,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function createProperty(address: string): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env).insert(properties).values({
    id,
    address,
    addressNormalized: address.toLowerCase(),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createOwner(
  propertyId: string,
  fullName: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(owners)
    .values({ id, propertyId, fullName, createdAt: now, updatedAt: now });
  return id;
}

describe('meetings admin route — member attendance', () => {
  it('records attendance per property', async () => {
    const id = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    const p2 = await createProperty('2 Oak St');
    const owner1 = await createOwner(p1, 'A. Reyes');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [
          {
            propertyId: p1,
            present: true,
            representedByOwnerId: owner1,
            viaProxy: false,
          },
          { propertyId: p2, present: false },
        ],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, id));
    expect(rows.length).toBe(2);
    const row1 = rows.find((r) => r.propertyId === p1);
    expect(row1?.present).toBe(true);
    expect(row1?.representedByOwnerId).toBe(owner1);
    expect(row1?.viaProxy).toBe(false);
    const row2 = rows.find((r) => r.propertyId === p2);
    expect(row2?.present).toBe(false);
    expect(row2?.representedByOwnerId).toBeNull();
    expect(row2?.viaProxy).toBe(false);
  });

  it('full-replace removes an omitted property', async () => {
    const id = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    const p2 = await createProperty('2 Oak St');
    const first = await POST(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [
          { propertyId: p1, present: true },
          { propertyId: p2, present: false },
        ],
      }),
    );
    expect(first.status).toBe(204);
    let rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, id));
    expect(rows.length).toBe(2);

    const second = await POST(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [{ propertyId: p1, present: true }],
      }),
    );
    expect(second.status).toBe(204);
    rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].propertyId).toBe(p1);
  });

  it('empty entries clears attendance', async () => {
    const id = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    await POST(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [{ propertyId: p1, present: true }],
      }),
    );
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, id));
    expect(rows.length).toBe(0);
  });

  it('setMemberAttendance on a nonexistent meeting returns 404', async () => {
    const p1 = await createProperty('1 Oak St');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'nope',
        entries: [{ propertyId: p1, present: true }],
      }),
    );
    expect(res.status).toBe(404);
  });

  it('setMemberAttendance on a board-body meeting returns 409', async () => {
    const boardRes = await POST(
      req(url, 'POST', {
        body: 'board',
        kind: 'regular',
        date: '2026-01-01',
        title: 'Board meeting',
      }),
    );
    expect(boardRes.status).toBe(201);
    const boardId = ((await boardRes.json()) as { id: string }).id;
    const p1 = await createProperty('1 Oak St');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: boardId,
        entries: [{ propertyId: p1, present: true }],
      }),
    );
    expect(res.status).toBe(409);
    const rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, boardId));
    expect(rows.length).toBe(0);
  });
});
