import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST } from '../../src/pages/api/admin/motions';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  motions,
  memberVotes,
  properties,
  owners,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberVotes);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
});

const url = 'http://localhost/api/admin/motions';
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
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'member',
      kind: 'annual',
      date: '2026-01-01',
      title: 'Annual meeting',
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

async function createBoardMeeting(): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env).insert(meetings).values({
    id,
    body: 'board',
    kind: 'regular',
    date: '2026-01-01',
    title: 'Board meeting',
    status: 'draft',
    visibility: 'board',
    createdBy: 'b',
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

async function createProperty(
  address: string,
  voteWeight = 1,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env).insert(properties).values({
    id,
    address,
    addressNormalized: address.toLowerCase(),
    voteWeight,
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

describe('motions admin route — member votes', () => {
  it('records one vote per property, stamped with the property weight', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createProperty('1 Oak St', 2);
    const p2 = await createProperty('2 Oak St', 1);
    const owner1 = await createOwner(p1, 'A. Reyes');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [
          {
            propertyId: p1,
            choice: 'yes',
            castByOwnerId: owner1,
            viaProxy: false,
          },
          { propertyId: p2, choice: 'no' },
        ],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(2);
    const row1 = rows.find((r) => r.propertyId === p1);
    expect(row1?.choice).toBe('yes');
    expect(row1?.weight).toBe(2);
    expect(row1?.castByOwnerId).toBe(owner1);
    expect(row1?.viaProxy).toBe(false);
    const row2 = rows.find((r) => r.propertyId === p2);
    expect(row2?.choice).toBe('no');
    expect(row2?.weight).toBe(1);
    expect(row2?.castByOwnerId).toBeNull();
    expect(row2?.viaProxy).toBe(false);
  });

  it('full-replace removes an omitted property', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createProperty('1 Oak St');
    const p2 = await createProperty('2 Oak St');
    const first = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [
          { propertyId: p1, choice: 'yes' },
          { propertyId: p2, choice: 'no' },
        ],
      }),
    );
    expect(first.status).toBe(204);
    let rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(2);

    const second = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: p1, choice: 'abstain' }],
      }),
    );
    expect(second.status).toBe(204);
    rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].propertyId).toBe(p1);
    expect(rows[0].choice).toBe('abstain');
  });

  it('empty entries clears the vote set', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createProperty('1 Oak St');
    await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: p1, choice: 'yes' }],
      }),
    );
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('setMemberVotes on a nonexistent motion returns 404', async () => {
    const p1 = await createProperty('1 Oak St');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: 'nope',
        entries: [{ propertyId: p1, choice: 'yes' }],
      }),
    );
    expect(res.status).toBe(404);
  });

  it('setMemberVotes on a board-body meeting returns 409 and writes nothing', async () => {
    const boardMeetingId = await createBoardMeeting();
    const id = await createMotion(boardMeetingId);
    const p1 = await createProperty('1 Oak St');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: p1, choice: 'yes' }],
      }),
    );
    expect(res.status).toBe(409);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('rejects an unknown propertyId with 400 and writes nothing, including the valid entry', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createProperty('1 Oak St');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [
          { propertyId: p1, choice: 'yes' },
          { propertyId: 'nope', choice: 'no' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('rejects choice "recused" with 400 and writes nothing', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createProperty('1 Oak St');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: p1, choice: 'recused' }],
      }),
    );
    expect(res.status).toBe(400);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('rejects choice "absent" with 400 and writes nothing', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createProperty('1 Oak St');
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: p1, choice: 'absent' }],
      }),
    );
    expect(res.status).toBe(400);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(0);
  });

  it('ignores a client-supplied weight and stamps the property weight instead', async () => {
    const meetingId = await createMeeting();
    const id = await createMotion(meetingId);
    const p1 = await createProperty('1 Oak St', 3);
    const res = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: p1, choice: 'yes', weight: 99 }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].weight).toBe(3);
  });
});
