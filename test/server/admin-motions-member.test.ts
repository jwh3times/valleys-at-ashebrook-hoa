import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { DELETE, PATCH, POST } from '../../src/pages/api/admin/motions';
import { DELETE as deleteMeeting } from '../../src/pages/api/admin/meetings';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  motionEligibility,
  motions,
  memberVotes,
  properties,
  owners,
  settings,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberVotes);
  await db.delete(motionEligibility);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
  await db.delete(settings);
});

const url = 'http://localhost/api/admin/motions';
const now = new Date();
const originalD1Batch = env.DATABASE.batch.bind(env.DATABASE);
const originalD1Prepare = env.DATABASE.prepare.bind(env.DATABASE);

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

async function enableLiveVoting(): Promise<void> {
  await getDb(env)
    .insert(settings)
    .values({
      key: 'site',
      value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
      updatedAt: now,
    });
}

async function setLiveVotingEnabled(enabled: boolean): Promise<void> {
  await getDb(env)
    .update(settings)
    .set({
      value: JSON.stringify({ officialMode: true, liveVotingEnabled: enabled }),
      updatedAt: new Date(),
    })
    .where(eq(settings.key, 'site'));
}

async function transitionVoting(
  action: 'openVoting' | 'closeVoting',
  id: string,
): Promise<Response> {
  return POST(req(url, 'POST', { action, id }));
}

async function getMotion(id: string) {
  const rows = await getDb(env)
    .select()
    .from(motions)
    .where(eq(motions.id, id));
  return rows[0];
}

async function getEligibility(id: string) {
  return getDb(env)
    .select()
    .from(motionEligibility)
    .where(eq(motionEligibility.motionId, id));
}

function pauseNextBatch() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batchReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let paused = false;
  const spy = vi
    .spyOn(env.DATABASE, 'batch')
    .mockImplementation(async (statements) => {
      if (!paused) {
        paused = true;
        reached();
        await released;
      }
      return originalD1Batch(statements);
    });
  return {
    reached: batchReached,
    release,
    restore: () => spy.mockRestore(),
  };
}

function pauseNextStatement(pattern: RegExp) {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const statementReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let matched = false;
  const spy = vi
    .spyOn(env.DATABASE, 'prepare')
    .mockImplementation((query: string) => {
      const statement = originalD1Prepare(query);
      if (matched || !pattern.test(query)) return statement;
      matched = true;
      let executionPaused = false;
      const pause = async () => {
        if (executionPaused) return;
        executionPaused = true;
        reached();
        await released;
      };
      const wrap = (target: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(target, {
          get(inner, property) {
            if (property === 'bind')
              return (...values: unknown[]) => wrap(inner.bind(...values));
            if (property === 'run')
              return async () => {
                await pause();
                return inner.run();
              };
            if (property === 'all')
              return async () => {
                await pause();
                return inner.all();
              };
            if (property === 'first') return inner.first.bind(inner);
            if (property === 'raw')
              return async () => {
                await pause();
                return inner.raw();
              };
            return Reflect.get(inner, property, inner);
          },
        });
      return wrap(statement);
    });
  return {
    reached: statementReached,
    release,
    restore: () => spy.mockRestore(),
  };
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
    expect(row1?.proxyId).toBeNull();
    const row2 = rows.find((r) => r.propertyId === p2);
    expect(row2?.choice).toBe('no');
    expect(row2?.weight).toBe(1);
    expect(row2?.castByOwnerId).toBeNull();
    expect(row2?.proxyId).toBeNull();
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

  it('opens only a draft member motion with both live-voting flags enabled and no pre-entered votes', async () => {
    const propertyId = await createProperty('1 Oak St', 2);
    const boardMotionId = await createMotion(await createBoardMeeting());
    const approvedMotionId = await createMotion(
      await createMeeting({ status: 'approved' }),
    );
    const disabledMotionId = await createMotion(await createMeeting());

    expect(
      (await transitionVoting('openVoting', disabledMotionId)).status,
    ).toBe(409);

    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({ officialMode: false, liveVotingEnabled: true }),
        updatedAt: now,
      });
    expect(
      (await transitionVoting('openVoting', disabledMotionId)).status,
    ).toBe(409);
    await setLiveVotingEnabled(false);
    expect(
      (await transitionVoting('openVoting', disabledMotionId)).status,
    ).toBe(409);
    await setLiveVotingEnabled(true);
    expect((await transitionVoting('openVoting', boardMotionId)).status).toBe(
      409,
    );
    expect(
      (await transitionVoting('openVoting', approvedMotionId)).status,
    ).toBe(409);

    const preenteredMotionId = await createMotion(await createMeeting());
    const entered = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: preenteredMotionId,
        entries: [{ propertyId, choice: 'yes' }],
      }),
    );
    expect(entered.status).toBe(204);
    expect(
      (await transitionVoting('openVoting', preenteredMotionId)).status,
    ).toBe(409);

    for (const id of [
      boardMotionId,
      approvedMotionId,
      disabledMotionId,
      preenteredMotionId,
    ]) {
      expect((await getMotion(id)).votingState).toBe('none');
      expect(await getEligibility(id)).toEqual([]);
    }
  });

  it('requires at least one active property on first open', async () => {
    await enableLiveVoting();
    const inactiveId = await createProperty('1 Oak St');
    await getDb(env)
      .update(properties)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(eq(properties.id, inactiveId));
    const id = await createMotion(await createMeeting());

    expect((await transitionVoting('openVoting', id)).status).toBe(409);
    expect((await getMotion(id)).votingState).toBe('none');
    expect(await getEligibility(id)).toEqual([]);
  });

  it('freezes active property weights on first open and reuses the identical snapshot after close and reopen', async () => {
    await enableLiveVoting();
    const p1 = await createProperty('1 Oak St', 2);
    const p2 = await createProperty('2 Oak St', 0);
    const inactiveId = await createProperty('3 Oak St', 5);
    await getDb(env)
      .update(properties)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(eq(properties.id, inactiveId));
    const id = await createMotion(await createMeeting());

    expect((await transitionVoting('openVoting', id)).status).toBe(204);
    expect((await transitionVoting('openVoting', id)).status).toBe(409);
    expect((await getMotion(id)).votingState).toBe('open');
    const firstSnapshot = (await getEligibility(id))
      .map((row) => ({ propertyId: row.propertyId, weight: row.weight }))
      .sort((a, b) => a.propertyId.localeCompare(b.propertyId));
    expect(firstSnapshot).toEqual(
      [
        { propertyId: p1, weight: 2 },
        { propertyId: p2, weight: 0 },
      ].sort((a, b) => a.propertyId.localeCompare(b.propertyId)),
    );

    expect((await transitionVoting('closeVoting', id)).status).toBe(204);
    expect((await transitionVoting('closeVoting', id)).status).toBe(409);
    await getDb(env)
      .update(properties)
      .set({ voteWeight: 9, updatedAt: new Date() })
      .where(eq(properties.id, p1));
    const addedAfterFreeze = await createProperty('4 Oak St', 4);

    expect((await transitionVoting('openVoting', id)).status).toBe(204);
    const reopenedSnapshot = (await getEligibility(id))
      .map((row) => ({ propertyId: row.propertyId, weight: row.weight }))
      .sort((a, b) => a.propertyId.localeCompare(b.propertyId));
    expect(reopenedSnapshot).toEqual(firstSnapshot);
    expect(
      reopenedSnapshot.some((row) => row.propertyId === addedAfterFreeze),
    ).toBe(false);
  });

  it('blocks board corrections while open and uses snapshot weights, including explicit zero, after close', async () => {
    await enableLiveVoting();
    const p1 = await createProperty('1 Oak St', 0);
    const p2 = await createProperty('2 Oak St', 2);
    const id = await createMotion(await createMeeting());
    expect((await transitionVoting('openVoting', id)).status).toBe(204);

    const whileOpen = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: p1, choice: 'yes' }],
      }),
    );
    expect(whileOpen.status).toBe(409);
    expect(
      await getDb(env)
        .select()
        .from(memberVotes)
        .where(eq(memberVotes.motionId, id)),
    ).toEqual([]);

    expect((await transitionVoting('closeVoting', id)).status).toBe(204);
    await getDb(env)
      .update(properties)
      .set({ voteWeight: 8, updatedAt: new Date() })
      .where(eq(properties.id, p1));
    const outsideSnapshot = await createProperty('3 Oak St', 3);
    const corrected = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [
          { propertyId: p1, choice: 'yes' },
          { propertyId: p2, choice: 'no' },
        ],
      }),
    );
    expect(corrected.status).toBe(204);
    const correctedRows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(correctedRows.find((row) => row.propertyId === p1)?.weight).toBe(0);
    expect(correctedRows.find((row) => row.propertyId === p2)?.weight).toBe(2);

    const outside = await POST(
      req(url, 'POST', {
        action: 'setMemberVotes',
        motionId: id,
        entries: [{ propertyId: outsideSnapshot, choice: 'yes' }],
      }),
    );
    expect(outside.status).toBe(400);
    expect(
      await getDb(env)
        .select()
        .from(memberVotes)
        .where(eq(memberVotes.motionId, id)),
    ).toEqual(correctedRows);
  });

  it('allows close while the global flag is disabled but refuses reopen without mutating state or votes', async () => {
    await enableLiveVoting();
    const propertyId = await createProperty('1 Oak St', 2);
    const id = await createMotion(await createMeeting());
    expect((await transitionVoting('openVoting', id)).status).toBe(204);
    await getDb(env).insert(memberVotes).values({
      id: crypto.randomUUID(),
      motionId: id,
      propertyId,
      castByOwnerId: null,
      proxyId: null,
      weight: 2,
      choice: 'yes',
    });
    await setLiveVotingEnabled(false);

    expect((await transitionVoting('closeVoting', id)).status).toBe(204);
    expect((await getMotion(id)).votingState).toBe('closed');
    expect((await transitionVoting('openVoting', id)).status).toBe(409);
    expect((await getMotion(id)).votingState).toBe('closed');
    const votes = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, id));
    expect(votes).toHaveLength(1);
    expect(votes[0].choice).toBe('yes');
  });

  it('closeVoting refuses a board motion and a motion on an approved meeting', async () => {
    const boardId = await createMotion(await createBoardMeeting());
    const approvedId = await createMotion(
      await createMeeting({ status: 'approved' }),
    );
    await getDb(env)
      .update(motions)
      .set({ votingState: 'open', updatedAt: new Date() })
      .where(eq(motions.id, boardId));
    await getDb(env)
      .update(motions)
      .set({ votingState: 'open', updatedAt: new Date() })
      .where(eq(motions.id, approvedId));

    expect((await transitionVoting('closeVoting', boardId)).status).toBe(409);
    expect((await transitionVoting('closeVoting', approvedId)).status).toBe(
      409,
    );
    expect((await getMotion(boardId)).votingState).toBe('open');
    expect((await getMotion(approvedId)).votingState).toBe('open');
  });

  it('freezes all edits while open, permanently freezes text after first open, and retains the motion record', async () => {
    await enableLiveVoting();
    await createProperty('1 Oak St');
    const id = await createMotion(await createMeeting());
    expect((await transitionVoting('openVoting', id)).status).toBe(204);

    const editWhileOpen = await PATCH(
      req(url, 'PATCH', { id, outcome: 'failed' }),
    );
    expect(editWhileOpen.status).toBe(409);
    expect((await getMotion(id)).outcome).toBe('passed');

    expect((await transitionVoting('closeVoting', id)).status).toBe(204);
    const textAfterClose = await PATCH(
      req(url, 'PATCH', { id, text: 'Replace the motion text' }),
    );
    expect(textAfterClose.status).toBe(409);
    expect((await getMotion(id)).text).toBe('Move to approve the budget');

    const correctionAfterClose = await PATCH(
      req(url, 'PATCH', {
        id,
        moverPersonId: null,
        secondPersonId: null,
        outcome: 'failed',
      }),
    );
    expect(correctionAfterClose.status).toBe(204);
    expect((await getMotion(id)).outcome).toBe('failed');

    expect((await DELETE(req(url, 'DELETE', { id }))).status).toBe(409);
    expect(await getMotion(id)).toBeDefined();
  });

  it('retains a motion when an eligibility record exists even if its lifecycle state is inconsistent', async () => {
    const propertyId = await createProperty('1 Oak St');
    const id = await createMotion(await createMeeting());
    await getDb(env).insert(motionEligibility).values({
      motionId: id,
      propertyId,
      weight: 1,
    });

    expect((await DELETE(req(url, 'DELETE', { id }))).status).toBe(409);
    expect(await getMotion(id)).toBeDefined();
  });

  it('does not let a board correction replace votes after a concurrent first open commits', async () => {
    await enableLiveVoting();
    const propertyId = await createProperty('1 Oak St', 2);
    const id = await createMotion(await createMeeting());
    const barrier = pauseNextBatch();
    try {
      const correctionPromise = POST(
        req(url, 'POST', {
          action: 'setMemberVotes',
          motionId: id,
          entries: [{ propertyId, choice: 'yes' }],
        }),
      );
      await barrier.reached;
      expect((await transitionVoting('openVoting', id)).status).toBe(204);
      barrier.release();
      expect((await correctionPromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }
    expect((await getMotion(id)).votingState).toBe('open');
    expect(
      await getDb(env)
        .select()
        .from(memberVotes)
        .where(eq(memberVotes.motionId, id)),
    ).toEqual([]);
  });

  it('does not let a pre-open correction commit after concurrent first open and close creates a snapshot', async () => {
    await enableLiveVoting();
    await createProperty('1 Oak St', 2);
    const outsideSnapshot = await createProperty('2 Oak St', 7);
    await getDb(env)
      .update(properties)
      .set({ status: 'inactive', updatedAt: new Date() })
      .where(eq(properties.id, outsideSnapshot));
    const id = await createMotion(await createMeeting());
    const barrier = pauseNextBatch();
    try {
      const correctionPromise = POST(
        req(url, 'POST', {
          action: 'setMemberVotes',
          motionId: id,
          entries: [{ propertyId: outsideSnapshot, choice: 'yes' }],
        }),
      );
      await barrier.reached;
      expect((await transitionVoting('openVoting', id)).status).toBe(204);
      expect((await transitionVoting('closeVoting', id)).status).toBe(204);
      barrier.release();
      expect((await correctionPromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }
    expect((await getMotion(id)).votingState).toBe('closed');
    expect(
      await getDb(env)
        .select()
        .from(memberVotes)
        .where(eq(memberVotes.motionId, id)),
    ).toEqual([]);
    expect(
      (await getEligibility(id)).some(
        (row) => row.propertyId === outsideSnapshot,
      ),
    ).toBe(false);
  });

  it('does not let a text edit commit after a concurrent first open freezes the motion', async () => {
    await enableLiveVoting();
    await createProperty('1 Oak St');
    const id = await createMotion(await createMeeting());
    const barrier = pauseNextStatement(/update/i);
    try {
      const patchPromise = PATCH(
        req(url, 'PATCH', { id, text: 'Mutated after preflight' }),
      );
      await barrier.reached;
      expect((await transitionVoting('openVoting', id)).status).toBe(204);
      barrier.release();
      expect((await patchPromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }
    expect((await getMotion(id)).text).toBe('Move to approve the budget');
  });

  it('does not delete a motion after a concurrent first open creates durable history', async () => {
    await enableLiveVoting();
    await createProperty('1 Oak St');
    const id = await createMotion(await createMeeting());
    const barrier = pauseNextStatement(
      /^\s*delete\s+from\s+["`]?motions["`]?/i,
    );
    try {
      const deletePromise = DELETE(req(url, 'DELETE', { id }));
      await barrier.reached;
      expect((await transitionVoting('openVoting', id)).status).toBe(204);
      barrier.release();
      expect((await deletePromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }
    expect(await getMotion(id)).toBeDefined();
    expect(await getEligibility(id)).toHaveLength(1);
  });

  it('does not delete a meeting after a child motion concurrently creates durable history', async () => {
    await enableLiveVoting();
    await createProperty('1 Oak St');
    const meetingId = await createMeeting();
    const motionId = await createMotion(meetingId);
    const barrier = pauseNextStatement(
      /^\s*delete\s+from\s+["`]?meetings["`]?/i,
    );
    try {
      const deletePromise = deleteMeeting(
        req(url, 'DELETE', { id: meetingId }),
      );
      await barrier.reached;
      expect((await transitionVoting('openVoting', motionId)).status).toBe(204);
      barrier.release();
      expect((await deletePromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }
    expect(
      await getDb(env)
        .select()
        .from(meetings)
        .where(eq(meetings.id, meetingId)),
    ).toHaveLength(1);
    expect(await getEligibility(motionId)).toHaveLength(1);
  });
});
