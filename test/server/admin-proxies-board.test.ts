import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/proxies';
import { getDb } from '../../src/server/db/client';
import {
  proxies,
  properties,
  owners,
  meetings,
  elections,
  memberAttendance,
  ballots,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

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
  await db.delete(owners);
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

async function createOwner(
  propertyId: string,
  fullName = 'A. Reyes',
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(owners)
    .values({ id, propertyId, fullName, createdAt: now, updatedAt: now });
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
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
    expect(row.grantorOwnerId).toBe(grantorOwnerId);
    expect(row.meetingId).toBe(meetingId);
    expect(row.electionId).toBeNull();
  });

  // 2. POST happy path, election-scoped.
  it('POST creates an election-scoped proxy', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
    const grantorOwnerId = await createOwner(propertyId);
    const res = await POST(
      req(url, 'POST', { propertyId, grantorOwnerId, holderName: 'Jane' }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'Exactly one of meetingId or electionId is required',
    );
  });

  it('POST with both occasions returns 400', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
        grantorOwnerId: 'nope',
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Property not found');
  });

  it('POST with unknown grantorOwnerId returns 404 Owner not found', async () => {
    const propertyId = await createProperty();
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId: 'nope',
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Owner not found');
  });

  it('POST with unknown holderOwnerId returns 404 Holder owner not found', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
        holderName: 'Jane',
        holderOwnerId: 'nope',
        meetingId,
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Holder owner not found');
  });

  it('POST with unknown meetingId returns 404 Meeting not found', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
        holderName: 'Jane',
        meetingId: 'nope',
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Meeting not found');
  });

  it('POST with unknown electionId returns 404 Election not found', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
    const grantorOwnerId = await createOwner(otherPropertyId);
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'grantorOwnerId does not belong to this property',
    );
  });

  // 7. Duplicate (same lot, same occasion); control: different occasion ok.
  it('POST rejects a duplicate proxy for the same lot and occasion, control allows a different occasion', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const otherMeetingId = await createMeeting();
    const first = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    expect(first.status).toBe(201);
    const dup = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
        grantorOwnerId,
        holderName: 'Jane Third',
        meetingId: otherMeetingId,
      }),
    );
    expect(control.status).toBe(201);
  });

  // 8. PATCH edits holderName/holderOwnerId/grantorOwnerId.
  it('PATCH edits holderName, holderOwnerId, and grantorOwnerId, advancing updatedAt', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId, 'Original Grantor');
    const newGrantorOwnerId = await createOwner(propertyId, 'New Grantor');
    const holderOwnerId = await createOwner(propertyId, 'Holder Owner');
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
        holderOwnerId,
        grantorOwnerId: newGrantorOwnerId,
      }),
    );
    expect(res.status).toBe(204);
    const row = await getProxy(id);
    expect(row.holderName).toBe('New Name');
    expect(row.holderOwnerId).toBe(holderOwnerId);
    expect(row.grantorOwnerId).toBe(newGrantorOwnerId);
    expect(row.updatedAt.getTime()).toBeGreaterThan(past.getTime());
  });

  // 9. PATCH carrying meetingId/electionId/propertyId -> 400 'not editable'.
  it('PATCH rejects meetingId, electionId, and propertyId as not editable', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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

  // 10. PATCH setting holderOwnerId equal to the stored grantor.
  it('PATCH rejects holderOwnerId equal to the stored grantorOwnerId', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
        holderName: 'Jane',
        meetingId,
      }),
    );
    const { id } = (await createRes.json()) as { id: string };

    const res = await PATCH(
      req(url, 'PATCH', { id, holderOwnerId: grantorOwnerId }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'grantorOwnerId and holderOwnerId cannot be the same owner',
    );
    const row = await getProxy(id);
    expect(row.holderOwnerId).toBeNull();
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
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    const electionId = await createElection();
    const createRes = await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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

  it('GET returns proxies via fetchAdminProxies', async () => {
    const propertyId = await createProperty();
    const grantorOwnerId = await createOwner(propertyId);
    const meetingId = await createMeeting();
    await POST(
      req(url, 'POST', {
        propertyId,
        grantorOwnerId,
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
