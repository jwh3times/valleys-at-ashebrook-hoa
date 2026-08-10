import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import {
  POST as meetingsPost,
  DELETE as meetingsDelete,
} from '../../src/pages/api/admin/meetings';
import { POST as motionsPost } from '../../src/pages/api/admin/motions';
import { POST as electionsPost } from '../../src/pages/api/admin/elections';
import {
  fetchMeetingFor,
  fetchAdminMeeting,
  fetchAdminElections,
} from '../../src/server/content/reads';
import { getDb } from '../../src/server/db/client';
import * as fx from './fixtures';
import {
  proxies,
  meetings,
  elections,
  memberAttendance,
  memberVotes,
  ballots,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

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

beforeEach(fx.truncateAll);

async function seedProperty(id: string) {
  await fx.seedProperty(id);
}

async function seedOwner(id: string, propertyId: string) {
  await fx.seedOwner(id, propertyId);
}

async function seedMeeting(id: string) {
  await fx.seedMeeting(id, { date: '2026-03-01', createdBy: 'b' });
}

async function seedElection(id: string, meetingId: string | null = null) {
  await fx.seedElection(id, {
    meetingId,
    electionDate: '2026-03-01',
    status: 'draft',
    visibility: 'board',
    createdBy: 'b',
  });
}

const proxyRow = fx.proxyRow;

async function seedMotion(id: string, meetingId: string) {
  await fx.seedMotion(id, meetingId, { createdBy: 'b' });
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
    await seedMotion('mo1', 'm1');
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
    const votesRes = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [{ propertyId: 'p1', choice: 'yes', proxyId: 'px1' }],
      }),
    );
    expect(votesRes.status).toBe(204);
    await getDb(env)
      .update(meetings)
      .set({ status: 'approved', visibility: 'public' })
      .where(eq(meetings.id, 'm1'));
    const admin = await fetchAdminMeeting(env, 'm1');
    expect(admin!.memberAttendance[0].proxyId).toBe('px1');
    expect(admin!.memberAttendance[0].viaProxy).toBe(true);
    expect(admin!.motions[0].memberVotes[0].proxyId).toBe('px1');
    expect(admin!.motions[0].memberVotes[0].viaProxy).toBe(true);
    const pub = await fetchMeetingFor(env, 'visitor', 'm1');
    expect(pub!.memberAttendance[0].proxyId).toBeNull();
    expect(pub!.memberAttendance[0].viaProxy).toBe(true);
    expect(pub!.motions[0].memberVotes[0].proxyId).toBeNull();
    expect(pub!.motions[0].memberVotes[0].viaProxy).toBe(true);
  });
});

describe('DELETE /api/admin/meetings with proxies', () => {
  beforeEach(async () => {
    await seedProperty('p1');
    await seedOwner('o1', 'p1');
  });

  it('cascades attendance, votes, and proxies for a draft meeting in one statement', async () => {
    await seedMeeting('m1');
    await seedMotion('mo1', 'm1');
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('px1', { meetingId: 'm1' }));
    const attendanceRes = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [{ propertyId: 'p1', present: true, proxyId: 'px1' }],
      }),
    );
    expect(attendanceRes.status).toBe(204);
    const votesRes = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [{ propertyId: 'p1', choice: 'yes', proxyId: 'px1' }],
      }),
    );
    expect(votesRes.status).toBe(204);

    const res = await meetingsDelete(req(url, 'DELETE', { id: 'm1' }));
    expect(res.status).toBe(204);

    const db = getDb(env);
    expect(
      await db.select().from(meetings).where(eq(meetings.id, 'm1')),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(memberAttendance)
        .where(eq(memberAttendance.meetingId, 'm1')),
    ).toHaveLength(0);
    expect(await db.select().from(memberVotes)).toHaveLength(0);
    expect(
      await db.select().from(proxies).where(eq(proxies.id, 'px1')),
    ).toHaveLength(0);
  });

  it('refuses to delete a meeting whose proxy is cited by an election ballot after the election detaches', async () => {
    await seedMeeting('m1');
    await seedElection('e1', 'm1');
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('px1', { meetingId: 'm1' }));
    const ballotsRes = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', proxyId: 'px1' }],
      }),
    );
    expect(ballotsRes.status).toBe(204);

    // Detach the election from the meeting directly via Drizzle — simulating
    // a PATCH that clears meetingId after the ballot was already recorded.
    // The ballot still cites px1, which is still scoped to m1.
    await getDb(env)
      .update(elections)
      .set({ meetingId: null })
      .where(eq(elections.id, 'e1'));

    const blocked = await meetingsDelete(req(url, 'DELETE', { id: 'm1' }));
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toBe(
      'An election ballot cites a proxy for this meeting — remove those ballots first',
    );

    // Clearing the ballots lets the delete through.
    await getDb(env).delete(ballots);
    const res = await meetingsDelete(req(url, 'DELETE', { id: 'm1' }));
    expect(res.status).toBe(204);
  });
});

describe('owner provenance across the three entry-set routes', () => {
  // representedByOwnerId / cast_by_owner_id are real FKs to owners and D1
  // enforces them, so before the shared guard an unknown id left the route as
  // a raw FOREIGN KEY error from inside the batch — an unhandled 500. Only
  // setBallots pre-checked it; these pin all three.
  beforeEach(async () => {
    await seedProperty('p1');
    await seedOwner('o1', 'p1');
    await seedMeeting('m1');
  });

  it('rejects an unknown representedByOwnerId on setMemberAttendance with 400', async () => {
    const res = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [
          { propertyId: 'p1', present: true, representedByOwnerId: 'ghost' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown representedByOwnerId in entries');
    expect(await getDb(env).select().from(memberAttendance)).toHaveLength(0);
  });

  it('rejects an unknown castByOwnerId on setMemberVotes with 400', async () => {
    await seedMotion('mo1', 'm1');
    const res = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [{ propertyId: 'p1', choice: 'yes', castByOwnerId: 'ghost' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown castByOwnerId in entries');
    expect(await getDb(env).select().from(memberVotes)).toHaveLength(0);
  });

  it('rejects an unknown castByOwnerId on setBallots with 400', async () => {
    await seedElection('e1');
    const res = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', castByOwnerId: 'ghost' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Unknown castByOwnerId in entries');
    expect(await getDb(env).select().from(ballots)).toHaveLength(0);
  });

  it('accepts a known owner on each of the three routes', async () => {
    // The positive control: proves the 400s above come from the id being
    // unknown, not from the guard rejecting every owner reference.
    await seedMotion('mo1', 'm1');
    await seedElection('e1');

    const attendance = await meetingsPost(
      req(url, 'POST', {
        action: 'setMemberAttendance',
        meetingId: 'm1',
        entries: [
          { propertyId: 'p1', present: true, representedByOwnerId: 'o1' },
        ],
      }),
    );
    expect(attendance.status).toBe(204);

    const votes = await motionsPost(
      req(motionsUrl, 'POST', {
        action: 'setMemberVotes',
        motionId: 'mo1',
        entries: [{ propertyId: 'p1', choice: 'yes', castByOwnerId: 'o1' }],
      }),
    );
    expect(votes.status).toBe(204);

    const ballotsRes = await electionsPost(
      req(electionsUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', castByOwnerId: 'o1' }],
      }),
    );
    expect(ballotsRes.status).toBe(204);
  });

  it('rejects an entry naming both a proxy and an owner, on every route', async () => {
    await seedMotion('mo1', 'm1');
    await getDb(env)
      .insert(proxies)
      .values(proxyRow('px1', { meetingId: 'm1' }));

    const attendance = await meetingsPost(
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
    expect(attendance.status).toBe(400);
    expect(await attendance.text()).toContain('cannot carry both');

    const votes = await motionsPost(
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
    expect(votes.status).toBe(400);
    expect(await votes.text()).toContain('cannot carry both');
  });
});
