import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/proxies';
import { getDb } from '../../src/server/db/client';
import {
  proxies,
  properties,
  meetings,
  elections,
  memberAttendance,
  ballots,
} from '../../src/server/db/schema';
import { parties, people, ownerships } from '../../src/server/db/roster-schema';
import { eq } from 'drizzle-orm';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const url = 'http://localhost/api/admin/proxies';
const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberAttendance);
  await db.delete(ballots);
  await db.delete(proxies);
  await db.delete(elections);
  await db.delete(meetings);
  await db.delete(ownerships);
  await db.delete(people);
  await db.delete(parties);
  await db.delete(properties);
});

function req(u: string, method: string, body?: unknown) {
  return {
    request: new Request(u, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

async function createProperty(
  address = '1 Oak St',
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

/**
 * A roster Person holding a current Ownership of `propertyId` — who the
 * proxies record names as grantor or holder since #248 part 2 repointed those
 * columns from `owners` onto `people(party_id)`.
 *
 * `endDay` seeds a FORMER holder, which the route still accepts as a grantor
 * (a historical paper proxy stays recordable) while every use of that proxy is
 * refused.
 */
async function createPerson(
  propertyId: string,
  fullName = 'A. Reyes',
  endDay: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  const db = getDb(env);
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
    id: crypto.randomUUID(),
    ownerPartyId: id,
    lotId: propertyId,
    startDay: null,
    endDay,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createMeeting(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'member',
      kind: 'annual',
      date: '2026-03-01',
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

async function createElection(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(elections)
    .values({
      id,
      title: 'Board election',
      seats: 2,
      electionDate: '2026-03-01',
      source: 'recorded',
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

async function getProxy(id: string) {
  const rows = await getDb(env)
    .select()
    .from(proxies)
    .where(eq(proxies.id, id));
  return rows[0];
}

describe('proxies admin route — board', () => {
  // 1. POST happy path, meeting-scoped.
  it('POST creates a meeting-scoped proxy', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: '  Jane Q. Holder  ',
        meetingId,
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getProxy(id);
    expect(row).toBeDefined();
    expect(row.holderName).toBe('Jane Q. Holder');
    expect(row.createdBy).toBe('b');
    expect(row.propertyId).toBe(propertyId);
    expect(row.grantorPersonId).toBe(grantorPersonId);
    expect(row.meetingId).toBe(meetingId);
    expect(row.electionId).toBeNull();
  });

  // 2. POST happy path, election-scoped.
  it('POST creates an election-scoped proxy', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane Q. Holder',
        electionId,
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getProxy(id);
    expect(row.electionId).toBe(electionId);
    expect(row.meetingId).toBeNull();
  });

  // 3. POST with neither/both occasions -> 400 from the normalizer.
  it('POST with neither occasion returns 400', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const res = await POST(
      req(url, 'POST', { propertyId, grantorPersonId, holderName: 'Jane' }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'Exactly one of meetingId or electionId is required',
    );
  });

  it('POST with both occasions returns 400', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId,
        electionId,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'Exactly one of meetingId or electionId is required',
    );
  });

  // 4. Five FKs, five readable failures.
  it('POST with unknown propertyId returns 404 Property not found', async () => {
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId: 'nope',
        grantorPersonId: 'nope',
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Property not found');
  });

  it('POST with unknown grantorPersonId returns 404 Person not found', async () => {
    const propertyId = await createProperty();
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId: 'nope',
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Person not found');
  });

  it('POST with unknown holderPersonId returns 404 Holder person not found', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        holderPersonId: 'nope',
        meetingId,
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Holder person not found');
  });

  it('POST with unknown meetingId returns 404 Meeting not found', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId: 'nope',
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Meeting not found');
  });

  it('POST with unknown electionId returns 404 Election not found', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        electionId: 'nope',
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Election not found');
  });

  // 6. Grantor not an owner of the property.
  it('POST with a grantor from another property returns 400', async () => {
    const propertyId = await createProperty('1 Oak St');
    const otherPropertyId = await createProperty('2 Oak St');
    const grantorPersonId = await createPerson(otherPropertyId);
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'grantorPersonId does not hold authority for this property',
    );
  });

  // 7. Duplicate (same lot, same occasion); control: different occasion ok.
  it('POST rejects a duplicate proxy for the same lot and occasion, control allows a different occasion', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const otherMeetingId = await createMeeting();
    const first = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(first.status).toBe(201);
    const dup = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane Again',
        meetingId,
      }),
    );
    expect(dup.status).toBe(409);
    expect(await dup.text()).toBe(
      'This lot already has a proxy for this occasion',
    );
    const control = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane Third',
        meetingId: otherMeetingId,
      }),
    );
    expect(control.status).toBe(201);
  });

  // 8. PATCH edits holderName/holderPersonId/grantorPersonId.
  it('PATCH edits holderName, holderPersonId, and grantorPersonId, advancing updatedAt', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId, 'Original Grantor');
    const newGrantorPersonId = await createPerson(propertyId, 'New Grantor');
    const holderPersonId = await createPerson(propertyId, 'Holder Owner');
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Old Name',
        meetingId,
      }),
    );
    const { id } = (await createRes.json()) as { id: string };
    // Backdate so the updatedAt-advanced assertion is deterministic
    // regardless of how fast the test runs.
    const past = new Date(now.getTime() - 60_000);
    await getDb(env)
      .update(proxies)
      .set({ updatedAt: past })
      .where(eq(proxies.id, id));

    const res = await PATCH(
      req(url, 'PATCH', {
        id,
        holderName: '  New Name  ',
        holderPersonId,
        grantorPersonId: newGrantorPersonId,
      }),
    );
    expect(res.status).toBe(204);
    const row = await getProxy(id);
    expect(row.holderName).toBe('New Name');
    expect(row.holderPersonId).toBe(holderPersonId);
    expect(row.grantorPersonId).toBe(newGrantorPersonId);
    expect(row.updatedAt.getTime()).toBeGreaterThan(past.getTime());
  });

  // 9. PATCH carrying meetingId/electionId/propertyId -> 400 'not editable'.
  it('PATCH rejects meetingId, electionId, and propertyId as not editable', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const resMeeting = await PATCH(
      req(url, 'PATCH', { id, meetingId: 'other' }),
    );
    expect(resMeeting.status).toBe(400);
    expect(await resMeeting.text()).toMatch(/scope is not editable/);

    const resElection = await PATCH(
      req(url, 'PATCH', { id, electionId: 'other' }),
    );
    expect(resElection.status).toBe(400);
    expect(await resElection.text()).toMatch(/scope is not editable/);

    const resProperty = await PATCH(
      req(url, 'PATCH', { id, propertyId: 'other' }),
    );
    expect(resProperty.status).toBe(400);
    expect(await resProperty.text()).toMatch(/propertyId is not editable/);
  });

  // 10. PATCH setting holderPersonId equal to the stored grantor.
  it('PATCH rejects holderPersonId equal to the stored grantorPersonId', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const res = await PATCH(
      req(url, 'PATCH', { id, holderPersonId: grantorPersonId }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'grantorPersonId and holderPersonId cannot be the same person',
    );
    const row = await getProxy(id);
    expect(row.holderPersonId).toBeNull();
  });

  // 11. PATCH/DELETE unknown id -> 404 'Proxy not found'.
  it('PATCH on an unknown id returns 404 Proxy not found', async () => {
    const res = await PATCH(req(url, 'PATCH', { id: 'nope', holderName: 'X' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Proxy not found');
  });

  it('DELETE on an unknown id returns 404 Proxy not found', async () => {
    const res = await DELETE(req(url, 'DELETE', { id: 'nope' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Proxy not found');
  });

  // 12. DELETE of an unused proxy.
  it('DELETE removes an unused proxy', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const row = await getProxy(id);
    expect(row).toBeUndefined();
  });

  // 13. DELETE of a proxy referenced by attendance, then attendance + ballot,
  // then success once cleared.
  it('DELETE refuses an in-use proxy, naming what uses it, then succeeds once cleared', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    const electionId = await createElection();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    const { id: proxyId } = (await createRes.json()) as { id: string };

    const attendanceId = crypto.randomUUID();
    await getDb(env).insert(memberAttendance).values({
      id: attendanceId,
      meetingId,
      propertyId,
      present: true,
      proxyId,
    });

    const res1 = await DELETE(req(url, 'DELETE', { id: proxyId }));
    expect(res1.status).toBe(409);
    expect(await res1.text()).toBe(
      'Proxy is in use (attendance) — remove those records first',
    );

    const ballotId = crypto.randomUUID();
    await getDb(env).insert(ballots).values({
      id: ballotId,
      electionId,
      propertyId,
      weight: 1,
      proxyId,
      recordedAt: now,
    });

    const res2 = await DELETE(req(url, 'DELETE', { id: proxyId }));
    expect(res2.status).toBe(409);
    expect(await res2.text()).toBe(
      'Proxy is in use (attendance, ballots) — remove those records first',
    );

    await getDb(env)
      .delete(memberAttendance)
      .where(eq(memberAttendance.id, attendanceId));
    await getDb(env).delete(ballots).where(eq(ballots.id, ballotId));

    const res3 = await DELETE(req(url, 'DELETE', { id: proxyId }));
    expect(res3.status).toBe(204);
    const row = await getProxy(proxyId);
    expect(row).toBeUndefined();
  });

  it('POST rejects a proxy against a board meeting with 409, control member meeting still 201', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const boardMeetingId = await createMeeting({ body: 'board' });
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Alice Holder',
        meetingId: boardMeetingId,
        electionId: null,
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/member meetings/);

    // Positive control: the identical payload against a member meeting works,
    // so the 409 above can only be the body guard.
    const memberMeetingId = await createMeeting({ body: 'member' });
    const ok = await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Alice Holder',
        meetingId: memberMeetingId,
        electionId: null,
      }),
    );
    expect(ok.status).toBe(201);
  });

  it('GET returns proxies via fetchAdminProxies', async () => {
    const propertyId = await createProperty();
    const grantorPersonId = await createPerson(propertyId);
    const meetingId = await createMeeting();
    await POST(
      req(url, 'POST', {
        propertyId,
        grantorPersonId,
        holderName: 'Listed Holder',
        meetingId,
      }),
    );
    const res = await GET(req(url, 'GET'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { holderName: string }[];
    expect(rows.some((r) => r.holderName === 'Listed Holder')).toBe(true);
  });
});
