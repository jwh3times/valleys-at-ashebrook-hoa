import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { GET, POST, DELETE } from '../../src/pages/api/member/proxies';
import { getDb } from '../../src/server/db/client';
import {
  settings,
  properties,
  owners,
  meetings,
  elections,
  proxies,
  memberAttendance,
} from '../../src/server/db/schema';
import type { AuthContext } from '../../src/server/authz/guards';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();
const url = 'http://localhost/api/member/proxies';

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberAttendance);
  await db.delete(proxies);
  await db.delete(elections);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
  await db.delete(settings).where(eq(settings.key, 'site'));
  // Default ON for this suite; the gate's off-behavior is covered in
  // member-guards.test.ts and the meta-test.
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true }),
    updatedAt: now,
  });
});

function call(
  handler: typeof GET,
  method: string,
  ctx: AuthContext | null,
  body?: unknown,
) {
  return handler({
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    locals: { authContext: ctx } as unknown as App.Locals,
  } as never);
}

const jane: AuthContext = {
  userId: 'u1',
  role: 'homeowner',
  propertyIds: ['p1'],
};

async function seedRoster() {
  const db = getDb(env);
  await db.insert(properties).values([
    {
      id: 'p1',
      address: '1 Oak St',
      addressNormalized: '1 oak st',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'p2',
      address: '2 Oak St',
      addressNormalized: '2 oak st',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(owners).values([
    {
      id: 'o1',
      propertyId: 'p1',
      fullName: 'Jane Doe',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'o1b',
      propertyId: 'p1',
      fullName: 'Inactive Owner',
      status: 'inactive',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'o2',
      propertyId: 'p2',
      fullName: 'John Roe',
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

async function seedMeeting(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? crypto.randomUUID();
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'member',
      kind: 'annual',
      date: '2099-01-01',
      title: 'Annual meeting',
      status: 'draft',
      visibility: 'homeowner',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

async function seedElection(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? crypto.randomUUID();
  await getDb(env)
    .insert(elections)
    .values({
      id,
      title: 'Board election',
      seats: 2,
      electionDate: '2099-01-01',
      source: 'recorded',
      status: 'draft',
      visibility: 'homeowner',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

function grantBody(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: 'p1',
    grantorOwnerId: 'o1',
    holderOwnerId: 'o2',
    meetingId: 'm1',
    electionId: null,
    ...overrides,
  };
}

describe('POST /api/member/proxies', () => {
  it('grants a proxy for the caller lot: 201, holderName copied from the owner row, createdBy = caller', async () => {
    await seedRoster();
    await seedMeeting({ id: 'm1' });
    const res = await call(POST, 'POST', jane, grantBody());
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [row] = await getDb(env)
      .select()
      .from(proxies)
      .where(eq(proxies.id, id));
    expect(row.holderName).toBe('John Roe');
    expect(row.holderOwnerId).toBe('o2');
    expect(row.createdBy).toBe('u1');
    expect(row.meetingId).toBe('m1');
  });

  it('grants against an election occasion too', async () => {
    await seedRoster();
    await seedElection({ id: 'e1' });
    const res = await call(
      POST,
      'POST',
      jane,
      grantBody({ meetingId: null, electionId: 'e1' }),
    );
    expect(res.status).toBe(201);
  });

  it('403s a lot the caller has not verified, whether or not it exists', async () => {
    await seedRoster();
    await seedMeeting({ id: 'm1' });
    const other = await call(
      POST,
      'POST',
      jane,
      grantBody({ propertyId: 'p2', grantorOwnerId: 'o2' }),
    );
    expect(other.status).toBe(403);
    const missing = await call(
      POST,
      'POST',
      jane,
      grantBody({ propertyId: 'nope' }),
    );
    expect(missing.status).toBe(403);
  });

  it('400s a grantor who is not an ACTIVE owner of the lot', async () => {
    await seedRoster();
    await seedMeeting({ id: 'm1' });
    const wrongLot = await call(
      POST,
      'POST',
      jane,
      grantBody({ grantorOwnerId: 'o2' }),
    );
    expect(wrongLot.status).toBe(400);
    const inactive = await call(
      POST,
      'POST',
      jane,
      grantBody({ grantorOwnerId: 'o1b' }),
    );
    expect(inactive.status).toBe(400);
  });

  it('404s an unknown or not-tier-visible occasion identically', async () => {
    await seedRoster();
    await seedMeeting({ id: 'mBoardOnly', visibility: 'board' });
    const unknown = await call(
      POST,
      'POST',
      jane,
      grantBody({ meetingId: 'nope' }),
    );
    expect(unknown.status).toBe(404);
    const hidden = await call(
      POST,
      'POST',
      jane,
      grantBody({ meetingId: 'mBoardOnly' }),
    );
    expect(hidden.status).toBe(404);
    expect(await unknown.text()).toBe(await hidden.text());
  });

  it('409s a board-body meeting, a past occasion, and a terminal election', async () => {
    await seedRoster();
    await seedMeeting({ id: 'mBoard', body: 'board' });
    await seedMeeting({ id: 'mPast', date: '2020-01-01' });
    await seedElection({ id: 'eClosed', status: 'closed' });
    expect(
      (await call(POST, 'POST', jane, grantBody({ meetingId: 'mBoard' })))
        .status,
    ).toBe(409);
    expect(
      (await call(POST, 'POST', jane, grantBody({ meetingId: 'mPast' })))
        .status,
    ).toBe(409);
    expect(
      (
        await call(
          POST,
          'POST',
          jane,
          grantBody({ meetingId: null, electionId: 'eClosed' }),
        )
      ).status,
    ).toBe(409);
  });

  it('404s an unknown/inactive holder, 400s holder = grantor, 400s both-or-neither occasion', async () => {
    await seedRoster();
    await seedMeeting({ id: 'm1' });
    expect(
      (await call(POST, 'POST', jane, grantBody({ holderOwnerId: 'nope' })))
        .status,
    ).toBe(404);
    expect(
      (await call(POST, 'POST', jane, grantBody({ holderOwnerId: 'o1b' })))
        .status,
    ).toBe(404);
    expect(
      (await call(POST, 'POST', jane, grantBody({ holderOwnerId: 'o1' })))
        .status,
    ).toBe(400);
    expect(
      (await call(POST, 'POST', jane, grantBody({ electionId: 'e1' }))).status,
    ).toBe(400);
    expect(
      (
        await call(
          POST,
          'POST',
          jane,
          grantBody({ meetingId: null, electionId: null }),
        )
      ).status,
    ).toBe(400);
  });

  it('409s a duplicate occasion for the lot', async () => {
    await seedRoster();
    await seedMeeting({ id: 'm1' });
    expect((await call(POST, 'POST', jane, grantBody())).status).toBe(201);
    const dup = await call(POST, 'POST', jane, grantBody());
    expect(dup.status).toBe(409);
    expect(await dup.text()).toBe(
      'This lot already has a proxy for this occasion',
    );
  });
});

describe('GET /api/member/proxies', () => {
  it('returns only the caller-scoped lists', async () => {
    await seedRoster();
    await seedMeeting({ id: 'm1' });
    await call(POST, 'POST', jane, grantBody());
    const db = getDb(env);
    // Another lot's proxy, held by Jane (o1):
    await db.insert(proxies).values({
      id: 'pxH',
      propertyId: 'p2',
      grantorOwnerId: 'o2',
      holderName: 'Jane Doe',
      holderOwnerId: 'o1',
      meetingId: 'm1',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const res = await call(GET, 'GET', jane);
    expect(res.status).toBe(200);
    const lists = (await res.json()) as {
      granted: { propertyId: string }[];
      held: { id: string }[];
    };
    expect(lists.granted).toHaveLength(1);
    expect(lists.granted[0].propertyId).toBe('p1');
    expect(lists.held.map((p) => p.id)).toEqual(['pxH']);
  });
});

describe('DELETE /api/member/proxies', () => {
  it("revokes an unused proxy on the caller lot; 404s unknown ids and other lots' proxies identically", async () => {
    await seedRoster();
    await seedMeeting({ id: 'm1' });
    const created = await call(POST, 'POST', jane, grantBody());
    const { id } = (await created.json()) as { id: string };
    const db = getDb(env);
    await db.insert(proxies).values({
      id: 'pxOther',
      propertyId: 'p2',
      grantorOwnerId: 'o2',
      holderName: 'Someone',
      meetingId: 'm1',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const others = await call(DELETE, 'DELETE', jane, { id: 'pxOther' });
    expect(others.status).toBe(404);
    const unknown = await call(DELETE, 'DELETE', jane, { id: 'nope' });
    expect(unknown.status).toBe(404);
    expect(await others.text()).toBe(await unknown.text());
    const ok = await call(DELETE, 'DELETE', jane, { id });
    expect(ok.status).toBe(204);
    expect(
      (await db.select().from(proxies).where(eq(proxies.id, id))).length,
    ).toBe(0);
  });

  it('409s a cited proxy, naming where it is used', async () => {
    await seedRoster();
    const m1 = await seedMeeting({ id: 'm1' });
    const created = await call(POST, 'POST', jane, grantBody());
    const { id } = (await created.json()) as { id: string };
    // member_attendance carries no timestamp columns (see schema.ts) — only
    // the row identity, the flag, and the optional owner/proxy references.
    await getDb(env).insert(memberAttendance).values({
      id: 'ma1',
      meetingId: m1,
      propertyId: 'p1',
      present: true,
      proxyId: id,
    });
    const res = await call(DELETE, 'DELETE', jane, { id });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/attendance/);
  });

  it('409s a proxy scoped to a past meeting; the row survives', async () => {
    await seedRoster();
    // POST would refuse a past meeting, so insert the proxy row directly —
    // this stands in for a board-entered paper record against an occasion
    // that has already happened.
    const pastMeeting = await seedMeeting({
      id: 'mPastDel',
      date: '2020-01-01',
    });
    const db = getDb(env);
    await db.insert(proxies).values({
      id: 'pxPastMeeting',
      propertyId: 'p1',
      grantorOwnerId: 'o1',
      holderName: 'John Roe',
      holderOwnerId: 'o2',
      meetingId: pastMeeting,
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const res = await call(DELETE, 'DELETE', jane, { id: 'pxPastMeeting' });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already passed/);
    expect(
      (await db.select().from(proxies).where(eq(proxies.id, 'pxPastMeeting')))
        .length,
    ).toBe(1);
  });

  it('409s a proxy scoped to a past election', async () => {
    await seedRoster();
    const pastElection = await seedElection({
      id: 'ePastDel',
      electionDate: '2020-01-01',
    });
    const db = getDb(env);
    await db.insert(proxies).values({
      id: 'pxPastElection',
      propertyId: 'p1',
      grantorOwnerId: 'o1',
      holderName: 'John Roe',
      holderOwnerId: 'o2',
      electionId: pastElection,
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const res = await call(DELETE, 'DELETE', jane, { id: 'pxPastElection' });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already passed/);
  });
});
