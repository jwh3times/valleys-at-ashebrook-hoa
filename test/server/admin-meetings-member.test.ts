import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import {
  DELETE as deleteMeeting,
  POST as postMeeting,
} from '../../src/pages/api/admin/meetings';
import { POST as postMotion } from '../../src/pages/api/admin/motions';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  memberAttendance,
  motionEligibility,
  motions,
  properties,
  settings,
  boardPeople,
} from '../../src/server/db/schema';
import { parties, people, ownerships } from '../../src/server/db/roster-schema';
import { eq } from 'drizzle-orm';
import { legacyAuthContext } from '../../src/server/authz/context';
import { seedPeopleRows } from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberAttendance);
  await db.delete(motionEligibility);
  await db.delete(motions);
  await db.delete(boardPeople);
  await db.delete(meetings);
  // #248 part 2: ownerships reference both parties and properties with
  // RESTRICT, so the roster goes before the lots it points at.
  await db.delete(ownerships);
  await db.delete(people);
  await db.delete(parties);
  await db.delete(properties);
  await db.delete(settings);
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
  const res = await postMeeting(
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

async function createPerson(
  propertyId: string,
  fullName: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb(env);
  // #248 part 2: the record names a roster Person holding Lot Authority.
  await db
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await db.insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName,
    nameNormalized: fullName.toLowerCase(),
    updatedAt: now,
  });
  await db.insert(ownerships).values({
    id: `${id}-own`,
    ownerPartyId: id,
    lotId: propertyId,
    startDay: null,
    endDay: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('meetings admin route — member attendance', () => {
  it('records attendance per property', async () => {
    const id = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    const p2 = await createProperty('2 Oak St');
    const owner1 = await createPerson(p1, 'A. Reyes');
    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [
          {
            propertyId: p1,
            present: true,
            representedByPersonId: owner1,
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
    expect(row1?.representedByPersonId).toBe(owner1);
    expect(row1?.proxyId).toBeNull();
    const row2 = rows.find((r) => r.propertyId === p2);
    expect(row2?.present).toBe(false);
    expect(row2?.representedByPersonId).toBeNull();
    expect(row2?.proxyId).toBeNull();
  });

  it('records a full 22-lot roll without exceeding D1 bound parameters', async () => {
    const id = await createMeeting();
    const propertyIds: string[] = [];
    for (let index = 1; index <= 22; index += 1) {
      propertyIds.push(await createProperty(`${index} Scale Test St`));
    }

    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: propertyIds.map((propertyId, index) => ({
          propertyId,
          present: index === 0,
          representedByPersonId: null,
          proxyId: null,
        })),
      }),
    );

    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, id));
    expect(rows).toHaveLength(22);
    expect(rows.filter((row) => row.present)).toHaveLength(1);
  });

  it('full-replace removes an omitted property', async () => {
    const id = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    const p2 = await createProperty('2 Oak St');
    const first = await postMeeting(
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

    const second = await postMeeting(
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
    await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [{ propertyId: p1, present: true }],
      }),
    );
    const res = await postMeeting(
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

  // #234: property_id is a NOT NULL FK to properties, and unlike its two
  // siblings this action stamps no weight, so nothing else resolved the lot
  // and an unknown id reached D1 as an unhandled 500. The inactive-lot check
  // below it does not cover this — that one is scoped to lots marked present
  // and reports nothing at all for an id matching no row.
  it('setMemberAttendance with an unknown propertyId returns 400, not a raw 500', async () => {
    const id = await createMeeting();
    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [{ propertyId: 'ghost', present: true }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown lots in entries: ghost');
    const rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, id));
    expect(rows.length).toBe(0);
  });

  it('setMemberAttendance reports an unknown lot marked absent, not only present ones', async () => {
    // The gap the inactive-lot check cannot close: it only inspects lots
    // marked present, so an absent unknown lot would fall straight through it.
    const id = await createMeeting();
    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [{ propertyId: 'ghost', present: false }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown lots in entries: ghost');
  });

  it('setMemberAttendance leaves the existing roll intact when one lot is unknown', async () => {
    const id = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    const seeded = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [{ propertyId: p1, present: true }],
      }),
    );
    expect(seeded.status).toBe(204);

    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: id,
        entries: [
          { propertyId: p1, present: false },
          { propertyId: 'ghost', present: true },
        ],
      }),
    );
    expect(res.status).toBe(400);
    // The guard runs before the delete, so the full replace never starts.
    const rows = await getDb(env)
      .select()
      .from(memberAttendance)
      .where(eq(memberAttendance.meetingId, id));
    expect(rows.length).toBe(1);
    expect(rows[0].present).toBe(true);
  });

  it('setMemberAttendance on a nonexistent meeting returns 404', async () => {
    const p1 = await createProperty('1 Oak St');
    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'nope',
        entries: [{ propertyId: p1, present: true }],
      }),
    );
    expect(res.status).toBe(404);
  });

  it('setMemberAttendance on a board-body meeting returns 409', async () => {
    const boardRes = await postMeeting(
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
    const res = await postMeeting(
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

  it('retains a parent meeting after a member motion first opens, including when only its eligibility snapshot remains', async () => {
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
        updatedAt: now,
      });
    const propertyId = await createProperty('1 Oak St');
    const meetingId = await createMeeting();
    const created = await postMotion(
      req(url, 'POST', {
        meetingId,
        text: 'Move to approve the budget',
        outcome: 'passed',
      }),
    );
    expect(created.status).toBe(201);
    const motionId = ((await created.json()) as { id: string }).id;
    const opened = await postMotion(
      req(url, 'POST', { action: 'openVoting', id: motionId }),
    );
    expect(opened.status).toBe(204);

    expect(
      (await deleteMeeting(req(url, 'DELETE', { id: meetingId }))).status,
    ).toBe(409);
    expect(
      await getDb(env)
        .select()
        .from(meetings)
        .where(eq(meetings.id, meetingId)),
    ).toHaveLength(1);

    await getDb(env)
      .update(motions)
      .set({ votingState: 'none', updatedAt: new Date() })
      .where(eq(motions.id, motionId));
    expect(
      await getDb(env)
        .select()
        .from(motionEligibility)
        .where(eq(motionEligibility.motionId, motionId)),
    ).toEqual([{ motionId, propertyId, weight: 1 }]);
    expect(
      (await deleteMeeting(req(url, 'DELETE', { id: meetingId }))).status,
    ).toBe(409);
    expect(
      await getDb(env)
        .select()
        .from(meetings)
        .where(eq(meetings.id, meetingId)),
    ).toHaveLength(1);
  });
});

describe('ADR 0015 server backstops for the member record', () => {
  // These rules existed only in the Meetings panel until now: the browser
  // excluded inactive lots from the voting editors and re-nulled a board
  // mover/second on a member motion, while the routes wrote whatever arrived.
  const motionsUrl = 'http://localhost/api/admin/motions';

  async function deactivate(propertyId: string) {
    await getDb(env)
      .update(properties)
      .set({ status: 'inactive' })
      .where(eq(properties.id, propertyId));
  }

  it('refuses to record an inactive lot as present', async () => {
    const meetingId = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    await deactivate(p1);

    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId,
        entries: [{ propertyId: p1, present: true }],
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.text()).toContain('cannot be recorded present');
    expect(await getDb(env).select().from(memberAttendance)).toHaveLength(0);
  });

  it('still accepts an inactive lot recorded ABSENT', async () => {
    // The panel renders only active lots but submits every property, so a lot
    // deactivated since the meeting legitimately arrives as absent. Rejecting
    // those would make a historical roll impossible to re-save.
    const meetingId = await createMeeting();
    const active = await createProperty('1 Oak St');
    const gone = await createProperty('2 Oak St');
    await deactivate(gone);

    const res = await postMeeting(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId,
        entries: [
          { propertyId: active, present: true },
          { propertyId: gone, present: false },
        ],
      }),
    );

    expect(res.status).toBe(204);
    expect(await getDb(env).select().from(memberAttendance)).toHaveLength(2);
  });

  it('refuses to record a vote for an inactive lot before voting first opens', async () => {
    const meetingId = await createMeeting();
    const p1 = await createProperty('1 Oak St');
    await deactivate(p1);
    const created = await postMotion(
      req(motionsUrl, 'POST', {
        meetingId,
        text: 'Approve the budget',
        outcome: 'passed',
      }),
    );
    const motionId = ((await created.json()) as { id: string }).id;

    const res = await postMotion(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId,
        entries: [{ propertyId: p1, choice: 'yes' }],
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Inactive lots cannot be recorded');
  });

  it('refuses a board mover or second on a member motion', async () => {
    const meetingId = await createMeeting();
    const personId = crypto.randomUUID();
    await seedPeopleRows({
      id: personId,
      fullName: 'B. Ortiz',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await postMotion(
      req(motionsUrl, 'POST', {
        meetingId,
        text: 'Approve the budget',
        outcome: 'passed',
        moverPersonId: personId,
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.text()).toContain('cannot name a board member');
    expect(await getDb(env).select().from(motions)).toHaveLength(0);
  });

  it('still accepts a board mover on a BOARD meeting', async () => {
    // The positive control: the rule is about the meeting's body, not about
    // board people being unusable.
    const meetingId = await createMeeting({ body: 'board' });
    const personId = crypto.randomUUID();
    await seedPeopleRows({
      id: personId,
      fullName: 'B. Ortiz',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await postMotion(
      req(motionsUrl, 'POST', {
        meetingId,
        text: 'Approve the budget',
        outcome: 'passed',
        moverPersonId: personId,
      }),
    );

    expect(res.status).toBe(201);
  });
});
