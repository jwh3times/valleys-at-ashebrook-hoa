import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST as meetingsPost } from '../../src/pages/api/admin/meetings';
import { POST as motionsPost } from '../../src/pages/api/admin/motions';
import { POST as electionsPost } from '../../src/pages/api/admin/elections';
import {
  fetchMeetingFor,
  fetchAdminMeeting,
  fetchAdminElections,
} from '../../src/server/content/reads';
import { getDb } from '../../src/server/db/client';
import {
  proxies,
  properties,
  owners,
  meetings,
  motions,
  elections,
  memberAttendance,
  memberVotes,
  ballots,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();
const url = 'http://localhost/api/admin/meetings';
const motionsUrl = 'http://localhost/api/admin/motions';
const electionsUrl = 'http://localhost/api/admin/elections';

function req(u: string, method: string, body?: unknown) {
  return {
    request: new Request(u, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

beforeEach(async () => {
  const db = getDb(env);
  // Child-to-parent order: memberAttendance/memberVotes/ballots carry a
  // proxy_id FK with NO ACTION (see schema.ts's proxyId comments), so they
  // must be cleared before proxies, and motions before meetings.
  await db.delete(ballots);
  await db.delete(memberVotes);
  await db.delete(memberAttendance);
  await db.delete(motions);
  await db.delete(proxies);
  await db.delete(elections);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
});

async function seedProperty(id: string) {
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Main St`,
      addressNormalized: `${id} main st`,
      unit: null,
      status: 'active',
      voteWeight: 1,
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedOwner(id: string, propertyId: string) {
  await getDb(env)
    .insert(owners)
    .values({
      id,
      propertyId,
      fullName: `Owner ${id}`,
      phone: null,
      email: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedMeeting(id: string) {
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'member',
      kind: 'annual',
      date: '2026-03-01',
      title: `Meeting ${id}`,
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
}

async function seedElection(id: string, meetingId: string | null = null) {
  await getDb(env)
    .insert(elections)
    .values({
      id,
      meetingId,
      title: `Election ${id}`,
      seats: 2,
      electionDate: '2026-03-01',
      source: 'recorded',
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
}

function proxyRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    propertyId: 'p1',
    grantorOwnerId: 'o1',
    holderName: 'Jane Q. Holder',
    holderOwnerId: null,
    meetingId: null,
    electionId: null,
    createdBy: 'b',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedMotion(id: string, meetingId: string) {
  await getDb(env)
    .insert(motions)
    .values({
      id,
      meetingId,
      sequence: 1,
      text: `Motion ${id}`,
      outcome: 'passed',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
}

describe('setMemberAttendance with proxyId', () => {
  beforeEach(async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedOwner('o1', 'p1');
    await seedMeeting('m1');
    await seedMeeting('m2');
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('px1', { meetingId: 'm1' }));
  });

  it('stores proxyId and the read derives viaProxy', async () => {
    const res = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [{ propertyId: 'p1', present: true, proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env).select().from(memberAttendance);
    expect(rows[0].proxyId).toBe('px1');
    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail!.memberAttendance[0].viaProxy).toBe(true);
    expect(detail!.memberAttendance[0].proxyId).toBe('px1');
  });

  it('rejects an unknown proxyId with a readable 400', async () => {
    const res = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [{ propertyId: 'p1', present: true, proxyId: 'nope' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown proxyId in entries');
  });

  it('rejects a proxy scoped to a different meeting with 409', async () => {
    const res = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm2',
        entries: [{ propertyId: 'p1', present: true, proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Proxy is scoped to a different occasion');
  });

  it("rejects another lot's proxy with 409", async () => {
    const res = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [{ propertyId: 'p2', present: true, proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Proxy is for a different lot');
  });

  it('rejects an entry carrying both proxyId and representedByOwnerId', async () => {
    const res = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [
          {
            propertyId: 'p1',
            present: true,
            proxyId: 'px1',
            representedByOwnerId: 'o1',
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'An entry cannot carry both proxyId and representedByOwnerId — who acted lives on the proxy record',
    );
  });
});

describe('setMemberVotes with proxyId', () => {
  beforeEach(async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedOwner('o1', 'p1');
    await seedMeeting('m1');
    await seedMeeting('m2');
    await seedMotion('mo1', 'm1');
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('px1', { meetingId: 'm1' }));
  });

  it('stores proxyId and the read derives viaProxy', async () => {
    const res = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [{ propertyId: 'p1', choice: 'yes', proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env).select().from(memberVotes);
    expect(rows[0].proxyId).toBe('px1');
    const detail = await fetchAdminMeeting(env, 'm1');
    expect(detail!.motions[0].memberVotes[0].viaProxy).toBe(true);
    expect(detail!.motions[0].memberVotes[0].proxyId).toBe('px1');
  });

  it('rejects an unknown proxyId with a readable 400', async () => {
    const res = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [{ propertyId: 'p1', choice: 'yes', proxyId: 'nope' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown proxyId in entries');
  });

  it('rejects a proxy scoped to a different meeting with 409', async () => {
    await seedMotion('mo2', 'm2');
    const res = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo2',
        entries: [{ propertyId: 'p1', choice: 'yes', proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Proxy is scoped to a different occasion');
  });

  it("rejects another lot's proxy with 409", async () => {
    const res = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [{ propertyId: 'p2', choice: 'yes', proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Proxy is for a different lot');
  });

  it('rejects an entry carrying both proxyId and castByOwnerId', async () => {
    const res = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [
          {
            propertyId: 'p1',
            choice: 'yes',
            proxyId: 'px1',
            castByOwnerId: 'o1',
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'An entry cannot carry both proxyId and castByOwnerId — who acted lives on the proxy record',
    );
  });
});

describe('setBallots with proxyId', () => {
  beforeEach(async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedOwner('o1', 'p1');
    await seedMeeting('m1');
    await seedElection('e1', null);
    await seedElection('e2', 'm1');
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('px1', { meetingId: 'm1' }));
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('pxE', { electionId: 'e1' }));
  });

  it('stores proxyId and the read derives viaProxy', async () => {
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', proxyId: 'pxE' }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env).select().from(ballots);
    expect(rows[0].proxyId).toBe('pxE');
    const admin = await fetchAdminElections(env);
    const e1 = admin.find((e) => e.id === 'e1');
    expect(e1!.ballots![0].viaProxy).toBe(true);
    expect(e1!.ballots![0].proxyId).toBe('pxE');
  });

  it('rejects an unknown proxyId with a readable 400', async () => {
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', proxyId: 'nope' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown proxyId in entries');
  });

  it('rejects a proxy scoped to a different election with 409', async () => {
    await seedElection('e3', null);
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e3',
        entries: [{ propertyId: 'p1', proxyId: 'pxE' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Proxy is scoped to a different occasion');
  });

  it("rejects another lot's proxy with 409", async () => {
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p2', proxyId: 'pxE' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Proxy is for a different lot');
  });

  it('rejects an entry carrying both proxyId and castByOwnerId', async () => {
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [
          {
            propertyId: 'p1',
            proxyId: 'pxE',
            castByOwnerId: 'o1',
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      'An entry cannot carry both proxyId and castByOwnerId — who acted lives on the proxy record',
    );
  });

  it('a meeting-scoped proxy covers an election held at that meeting', async () => {
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e2',
        entries: [{ propertyId: 'p1', proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getDb(env).select().from(ballots);
    expect(rows[0].proxyId).toBe('px1');
  });

  it("a standalone election does not accept another occasion's proxy", async () => {
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Proxy is scoped to a different occasion');
  });
});

describe('proxyId public/admin exposure', () => {
  it('proxyId reaches the admin read but not the public read', async () => {
    await seedProperty('p1');
    await seedOwner('o1', 'p1');
    await seedMeeting('m1');
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('px1', { meetingId: 'm1' }));
    const res = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [{ propertyId: 'p1', present: true, proxyId: 'px1' }],
      }),
    );
    expect(res.status).toBe(204);
    await getDb(env)
      .update(meetings)
      .set({ status: 'approved', visibility: 'public' })
      .where(eq(meetings.id, 'm1'));
    const admin = await fetchAdminMeeting(env, 'm1');
    expect(admin!.memberAttendance[0].proxyId).toBe('px1');
    expect(admin!.memberAttendance[0].viaProxy).toBe(true);
    const pub = await fetchMeetingFor(env, 'visitor', 'm1');
    expect(pub!.memberAttendance[0].proxyId).toBeNull();
    expect(pub!.memberAttendance[0].viaProxy).toBe(true);
  });
});
