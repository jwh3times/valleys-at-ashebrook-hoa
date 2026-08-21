import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/elections';
import { getDb } from '../../src/server/db/client';
import {
  elections,
  electionEligibility,
  candidates,
  ballotChoices,
  ballots,
  properties,
  owners,
  meetings,
  settings,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import { pauseNextBatch } from './fixtures';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(ballotChoices);
  await db.delete(ballots);
  await db.delete(electionEligibility);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(owners);
  await db.delete(properties);
  await db.delete(meetings);
  await db.delete(settings);
});

const url = 'http://localhost/api/admin/elections';
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

async function createElection(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(elections)
    .values({
      id,
      title: '2026 Board Election',
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

async function createCandidate(
  electionId: string,
  sequence: number,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(candidates)
    .values({
      id,
      electionId,
      fullName: `Candidate ${sequence}`,
      sequence,
      votes: null,
      won: false,
      withdrawn: false,
      createdAt: now,
      ...overrides,
    });
  return id;
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

async function createMeeting(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'board',
      kind: 'regular',
      date: '2026-01-01',
      title: 'January meeting',
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
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

async function getElection(id: string) {
  const rows = await getDb(env)
    .select()
    .from(elections)
    .where(eq(elections.id, id));
  return rows[0];
}

async function getCandidate(id: string) {
  const rows = await getDb(env)
    .select()
    .from(candidates)
    .where(eq(candidates.id, id));
  return rows[0];
}

async function getBallotsFor(electionId: string) {
  return getDb(env)
    .select()
    .from(ballots)
    .where(eq(ballots.electionId, electionId));
}

async function getEligibilityFor(electionId: string) {
  return getDb(env)
    .select()
    .from(electionEligibility)
    .where(eq(electionEligibility.electionId, electionId));
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

describe('elections admin route — board', () => {
  it('creates a draft election with source recorded', async () => {
    const res = await POST(
      req(url, 'POST', {
        title: '2026 Board Election',
        seats: 2,
        electionDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getElection(id);
    expect(row.status).toBe('draft');
    expect(row.source).toBe('recorded');
    expect(row.title).toBe('2026 Board Election');
    expect(row.createdBy).toBe('b');
  });

  it('rejects a create carrying status, with 400', async () => {
    const res = await POST(
      req(url, 'POST', {
        title: 'X',
        seats: 2,
        electionDate: '2026-03-01',
        status: 'closed',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/status is not editable/i);
    const rows = await getDb(env)
      .select()
      .from(elections)
      .where(eq(elections.title, 'X'));
    expect(rows.length).toBe(0);
  });

  it('creates a conducted election when source is selected at creation', async () => {
    const res = await POST(
      req(url, 'POST', {
        title: 'Conducted election',
        seats: 2,
        electionDate: '2026-03-01',
        source: 'conducted',
        visibility: 'homeowner',
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getElection(id);
    expect(row.source).toBe('conducted');
    expect(row.status).toBe('draft');
  });

  it('rejects seats of 0 with 400', async () => {
    const res = await POST(
      req(url, 'POST', {
        title: 'X',
        seats: 0,
        electionDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/seats must be at least 1/i);
    const rows = await getDb(env)
      .select()
      .from(elections)
      .where(eq(elections.title, 'X'));
    expect(rows.length).toBe(0);
  });

  it('rejects a create with an unknown meetingId, with 404', async () => {
    const res = await POST(
      req(url, 'POST', {
        title: 'X',
        seats: 2,
        electionDate: '2026-03-01',
        meetingId: 'nope',
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/meeting not found/i);
    const rows = await getDb(env)
      .select()
      .from(elections)
      .where(eq(elections.title, 'X'));
    expect(rows.length).toBe(0);
  });

  it('creates an election with a valid meetingId', async () => {
    const meetingId = await createMeeting();
    const res = await POST(
      req(url, 'POST', {
        title: 'X',
        seats: 2,
        electionDate: '2026-03-01',
        meetingId,
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getElection(id);
    expect(row.meetingId).toBe(meetingId);
  });

  it('close moves draft to closed', async () => {
    const id = await createElection();
    const res = await POST(req(url, 'POST', { action: 'close', id }));
    expect(res.status).toBe(204);
    const row = await getElection(id);
    expect(row.status).toBe('closed');
  });

  it('close on an already-closed election returns 409', async () => {
    const id = await createElection({ status: 'closed' });
    const res = await POST(req(url, 'POST', { action: 'close', id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/not a draft/i);
    const row = await getElection(id);
    expect(row.status).toBe('closed');
  });

  it('open fails closed when the live-voting database flag is off', async () => {
    const id = await createElection({
      source: 'conducted',
      visibility: 'homeowner',
    });
    await createCandidate(id, 1);
    await createProperty('1 Flag Off Lane');

    const res = await POST(req(url, 'POST', { action: 'open', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('draft');
    expect(await getEligibilityFor(id)).toEqual([]);
  });

  it('open refuses a recorded election without creating a snapshot', async () => {
    await enableLiveVoting();
    const id = await createElection({ visibility: 'homeowner' });
    await createCandidate(id, 1);
    await createProperty('2 Recorded Lane');

    const res = await POST(req(url, 'POST', { action: 'open', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('draft');
    expect(await getEligibilityFor(id)).toEqual([]);
  });

  it('open refuses a conducted election that is not a draft', async () => {
    await enableLiveVoting();
    const id = await createElection({
      source: 'conducted',
      status: 'closed',
      visibility: 'homeowner',
    });
    await createCandidate(id, 1);
    await createProperty('3 Closed Lane');

    const res = await POST(req(url, 'POST', { action: 'open', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('closed');
    expect(await getEligibilityFor(id)).toEqual([]);
  });

  it('open refuses board-only visibility without creating a snapshot', async () => {
    await enableLiveVoting();
    const id = await createElection({ source: 'conducted' });
    await createCandidate(id, 1);
    await createProperty('4 Board Lane');

    const res = await POST(req(url, 'POST', { action: 'open', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('draft');
    expect(await getEligibilityFor(id)).toEqual([]);
  });

  it('open requires at least one non-withdrawn candidate', async () => {
    await enableLiveVoting();
    const id = await createElection({
      source: 'conducted',
      visibility: 'homeowner',
    });
    await createCandidate(id, 1, { withdrawn: true });
    await createProperty('5 Candidate Lane');

    const res = await POST(req(url, 'POST', { action: 'open', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('draft');
    expect(await getEligibilityFor(id)).toEqual([]);
  });

  it('open requires at least one active property', async () => {
    await enableLiveVoting();
    const id = await createElection({
      source: 'conducted',
      visibility: 'homeowner',
    });
    await createCandidate(id, 1);
    const propertyId = await createProperty('6 Inactive Lane');
    await getDb(env)
      .update(properties)
      .set({ status: 'inactive' })
      .where(eq(properties.id, propertyId));

    const res = await POST(req(url, 'POST', { action: 'open', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('draft');
    expect(await getEligibilityFor(id)).toEqual([]);
  });

  it('atomically opens once and snapshots every active property weight', async () => {
    await enableLiveVoting();
    const id = await createElection({
      source: 'conducted',
      visibility: 'homeowner',
    });
    const candidateId = await createCandidate(id, 1);
    const firstPropertyId = await createProperty('7 First Lane', 2);
    const zeroPropertyId = await createProperty('8 Zero Lane', 0);
    const inactivePropertyId = await createProperty('9 Inactive Lane', 9);
    await getDb(env)
      .update(properties)
      .set({ status: 'inactive' })
      .where(eq(properties.id, inactivePropertyId));

    const responses = await Promise.all([
      POST(req(url, 'POST', { action: 'open', id })),
      POST(req(url, 'POST', { action: 'open', id })),
    ]);

    expect(responses.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      204, 409,
    ]);
    expect((await getElection(id)).status).toBe('open');
    expect((await getCandidate(candidateId)).votes).toBeNull();
    expect(
      (await getEligibilityFor(id))
        .map(({ propertyId, weight }) => ({ propertyId, weight }))
        .sort((a, b) => a.propertyId.localeCompare(b.propertyId)),
    ).toEqual(
      [
        { propertyId: firstPropertyId, weight: 2 },
        { propertyId: zeroPropertyId, weight: 0 },
      ].sort((a, b) => a.propertyId.localeCompare(b.propertyId)),
    );
  });

  it('conducted close stores weighted tallies including zero and retains anonymous choices', async () => {
    const id = await createElection({
      source: 'conducted',
      status: 'open',
      visibility: 'homeowner',
    });
    const firstCandidateId = await createCandidate(id, 1);
    const zeroCandidateId = await createCandidate(id, 2);
    const noChoiceCandidateId = await createCandidate(id, 3);
    await getDb(env)
      .insert(ballotChoices)
      .values([
        {
          id: crypto.randomUUID(),
          electionId: id,
          candidateId: firstCandidateId,
          weight: 2,
        },
        {
          id: crypto.randomUUID(),
          electionId: id,
          candidateId: firstCandidateId,
          weight: 3,
        },
        {
          id: crypto.randomUUID(),
          electionId: id,
          candidateId: zeroCandidateId,
          weight: 0,
        },
      ]);
    expect((await getCandidate(firstCandidateId)).votes).toBeNull();

    const res = await POST(req(url, 'POST', { action: 'close', id }));

    expect(res.status).toBe(204);
    expect((await getElection(id)).status).toBe('closed');
    expect((await getCandidate(firstCandidateId)).votes).toBe(5);
    expect((await getCandidate(zeroCandidateId)).votes).toBe(0);
    expect((await getCandidate(noChoiceCandidateId)).votes).toBe(0);
    const choices = await getDb(env)
      .select()
      .from(ballotChoices)
      .where(eq(ballotChoices.electionId, id));
    expect(choices).toHaveLength(3);
  });

  it('a losing conducted close does not recompute the stored tallies', async () => {
    const id = await createElection({
      source: 'conducted',
      status: 'closed',
      visibility: 'homeowner',
    });
    const candidateId = await createCandidate(id, 1, { votes: 9 });
    await getDb(env).insert(ballotChoices).values({
      id: crypto.randomUUID(),
      electionId: id,
      candidateId,
      weight: 3,
    });

    const res = await POST(req(url, 'POST', { action: 'close', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('closed');
    expect((await getCandidate(candidateId)).votes).toBe(9);
  });

  it('conducted close refuses a draft election', async () => {
    const id = await createElection({
      source: 'conducted',
      visibility: 'homeowner',
    });

    const res = await POST(req(url, 'POST', { action: 'close', id }));

    expect(res.status).toBe(409);
    expect((await getElection(id)).status).toBe('draft');
  });

  it('void accepts an open conducted election', async () => {
    const id = await createElection({
      source: 'conducted',
      status: 'open',
      visibility: 'homeowner',
    });

    const res = await POST(req(url, 'POST', { action: 'void', id }));

    expect(res.status).toBe(204);
    expect((await getElection(id)).status).toBe('void');
  });

  it('void moves a draft to void', async () => {
    const id = await createElection();
    const res = await POST(req(url, 'POST', { action: 'void', id }));
    expect(res.status).toBe(204);
    const row = await getElection(id);
    expect(row.status).toBe('void');
  });

  it('void moves a closed election to void', async () => {
    const id = await createElection({ status: 'closed' });
    const res = await POST(req(url, 'POST', { action: 'void', id }));
    expect(res.status).toBe(204);
    const row = await getElection(id);
    expect(row.status).toBe('void');
  });

  it('void on a certified election returns 409 naming uncertify', async () => {
    const id = await createElection();
    await getDb(env)
      .update(elections)
      .set({ status: 'certified' })
      .where(eq(elections.id, id));
    const res = await POST(req(url, 'POST', { action: 'void', id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/uncertify/i);
    const row = await getElection(id);
    expect(row.status).toBe('certified');
  });

  it('setTallies records votes per candidate', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    const c2 = await createCandidate(electionId, 2);
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [
          { candidateId: c1, votes: 10 },
          { candidateId: c2, votes: 5 },
        ],
      }),
    );
    expect(res.status).toBe(204);
    expect((await getCandidate(c1)).votes).toBe(10);
    expect((await getCandidate(c2)).votes).toBe(5);
  });

  it('setTallies clears an omitted candidate back to null', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    const c2 = await createCandidate(electionId, 2);
    await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [
          { candidateId: c1, votes: 10 },
          { candidateId: c2, votes: 5 },
        ],
      }),
    );
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [{ candidateId: c1, votes: 7 }],
      }),
    );
    expect(res.status).toBe(204);
    expect((await getCandidate(c1)).votes).toBe(7);
    expect((await getCandidate(c2)).votes).toBeNull();
  });

  it('setTallies rejects a candidate from another election with 400', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    const otherElectionId = await createElection({ title: 'Other' });
    const foreign = await createCandidate(otherElectionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [{ candidateId: foreign, votes: 1 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown candidate/i);
    expect((await getCandidate(c1)).votes).toBeNull();
    expect((await getCandidate(foreign)).votes).toBeNull();
  });

  it('setTallies rejects negative votes with 400', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [{ candidateId: c1, votes: -1 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/non-negative integer/i);
    expect((await getCandidate(c1)).votes).toBeNull();
  });

  it('setTallies rejects non-integer votes with 400', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [{ candidateId: c1, votes: 1.5 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/non-negative integer/i);
    expect((await getCandidate(c1)).votes).toBeNull();
  });

  it('setTallies rejects the same candidateId twice with 409', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [
          { candidateId: c1, votes: 1 },
          { candidateId: c1, votes: 2 },
        ],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/only one tally/i);
    expect((await getCandidate(c1)).votes).toBeNull();
  });

  it('setTallies on a certified election returns 409', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    await getDb(env)
      .update(elections)
      .set({ status: 'certified' })
      .where(eq(elections.id, electionId));
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [{ candidateId: c1, votes: 1 }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
    expect((await getCandidate(c1)).votes).toBeNull();
  });

  it('setTallies rejects a conducted election with 409 (unreachable via API — seeded directly)', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1);
    await getDb(env)
      .update(elections)
      .set({ source: 'conducted' })
      .where(eq(elections.id, electionId));
    const res = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [{ candidateId: c1, votes: 1 }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/recorded election/i);
    expect((await getCandidate(c1)).votes).toBeNull();
  });

  it('setBallots records the ballot set and stamps weight from the property', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 3);
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1 }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getBallotsFor(electionId);
    expect(rows.length).toBe(1);
    expect(rows[0].propertyId).toBe(p1);
    expect(rows[0].weight).toBe(3);
  });

  it('setBallots accepts an explicit weight for a recorded election', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1, weight: 5 }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getBallotsFor(electionId);
    expect(rows[0].weight).toBe(5);
  });

  it('setBallots rejects an explicit weight of 0 with 400', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1, weight: 0 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/positive integer/i);
    expect((await getBallotsFor(electionId)).length).toBe(0);
  });

  it('setBallots rejects an unknown propertyId with 400', async () => {
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: 'nope' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown property/i);
    expect((await getBallotsFor(electionId)).length).toBe(0);
  });

  it('setBallots rejects an unknown castByPersonId with 400', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1, castByPersonId: 'nope' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown castByPersonId/i);
    expect((await getBallotsFor(electionId)).length).toBe(0);
  });

  it('setBallots accepts a valid castByPersonId', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    const owner1 = await createOwner(p1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1, castByPersonId: owner1 }],
      }),
    );
    expect(res.status).toBe(204);
    const rows = await getBallotsFor(electionId);
    expect(rows[0].castByPersonId).toBe(owner1);
  });

  it('setBallots rejects the same propertyId twice with 409, not a raw D1 error', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1 }, { propertyId: p1 }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/one ballot/i);
    expect((await getBallotsFor(electionId)).length).toBe(0);
  });

  it('setBallots replaces the whole set rather than appending', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    const p2 = await createProperty('2 Oak St', 1);
    const first = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1 }, { propertyId: p2 }],
      }),
    );
    expect(first.status).toBe(204);
    expect((await getBallotsFor(electionId)).length).toBe(2);

    const second = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1 }],
      }),
    );
    expect(second.status).toBe(204);
    const rows = await getBallotsFor(electionId);
    expect(rows.length).toBe(1);
    expect(rows[0].propertyId).toBe(p1);
  });

  it('does not replace ballots after a concurrent void commits', async () => {
    const electionId = await createElection();
    const originalPropertyId = await createProperty('1 Oak St', 1);
    const replacementPropertyId = await createProperty('2 Oak St', 2);
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setBallots',
            electionId,
            entries: [{ propertyId: originalPropertyId }],
          }),
        )
      ).status,
    ).toBe(204);

    const barrier = pauseNextBatch();
    try {
      const replacementPromise = POST(
        req(url, 'POST', {
          action: 'setBallots',
          electionId,
          entries: [{ propertyId: replacementPropertyId }],
        }),
      );
      await barrier.reached;
      expect(
        (await POST(req(url, 'POST', { action: 'void', id: electionId })))
          .status,
      ).toBe(204);
      barrier.release();
      expect((await replacementPromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }

    expect((await getElection(electionId)).status).toBe('void');
    const rows = await getBallotsFor(electionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].propertyId).toBe(originalPropertyId);
    expect(rows[0].weight).toBe(1);
  });

  it('setBallots on a certified election returns 409', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    await getDb(env)
      .update(elections)
      .set({ status: 'certified' })
      .where(eq(elections.id, electionId));
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1 }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
    expect((await getBallotsFor(electionId)).length).toBe(0);
  });

  it('setBallots rejects a conducted election with 409 (unreachable via API — seeded directly)', async () => {
    const electionId = await createElection();
    const p1 = await createProperty('1 Oak St', 1);
    await getDb(env)
      .update(elections)
      .set({ source: 'conducted' })
      .where(eq(elections.id, electionId));
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [{ propertyId: p1 }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/recorded election/i);
    expect((await getBallotsFor(electionId)).length).toBe(0);
  });

  it('PATCH updates title, seats, and visibility', async () => {
    const id = await createElection();
    const res = await PATCH(
      req(url, 'PATCH', {
        id,
        title: 'Updated title',
        seats: 3,
        visibility: 'public',
      }),
    );
    expect(res.status).toBe(204);
    const row = await getElection(id);
    expect(row.title).toBe('Updated title');
    expect(row.seats).toBe(3);
    expect(row.visibility).toBe('public');
  });

  it('PATCH cannot change source', async () => {
    const id = await createElection();
    const res = await PATCH(req(url, 'PATCH', { id, source: 'conducted' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/source is not editable/i);
    const row = await getElection(id);
    expect(row.source).toBe('recorded');
  });

  it('PATCH freezes a conducted election once it has opened', async () => {
    for (const status of ['open', 'closed'] as const) {
      const id = await createElection({ source: 'conducted', status });

      const res = await PATCH(req(url, 'PATCH', { id, title: 'Changed' }));

      expect(res.status).toBe(409);
      expect((await getElection(id)).title).toBe('2026 Board Election');
    }
  });

  it('PATCH preserves recorded-election edits after close', async () => {
    const id = await createElection({ status: 'closed' });

    const res = await PATCH(
      req(url, 'PATCH', { id, title: 'Corrected historical title' }),
    );

    expect(res.status).toBe(204);
    expect((await getElection(id)).title).toBe('Corrected historical title');
  });

  it('PATCH on a certified election returns 409', async () => {
    const id = await createElection();
    await getDb(env)
      .update(elections)
      .set({ status: 'certified' })
      .where(eq(elections.id, id));
    const res = await PATCH(req(url, 'PATCH', { id, title: 'X' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
    const row = await getElection(id);
    expect(row.title).not.toBe('X');
  });

  it('PATCH on a void election returns 409', async () => {
    const id = await createElection({ status: 'void' });
    const res = await PATCH(req(url, 'PATCH', { id, title: 'X' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
    const row = await getElection(id);
    expect(row.title).not.toBe('X');
  });

  it('PATCH on a nonexistent election returns 404', async () => {
    const res = await PATCH(req(url, 'PATCH', { id: 'nope', title: 'X' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/election not found/i);
  });

  it('PATCH with no fields to update returns 400', async () => {
    const id = await createElection();
    const res = await PATCH(req(url, 'PATCH', { id }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/no fields to update/i);
  });

  it('PATCH rejects an unknown meetingId, with 404', async () => {
    const id = await createElection();
    const res = await PATCH(req(url, 'PATCH', { id, meetingId: 'nope' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/meeting not found/i);
    const row = await getElection(id);
    expect(row.meetingId).toBeNull();
  });

  it('PATCH accepts a valid meetingId', async () => {
    const id = await createElection();
    const meetingId = await createMeeting();
    const res = await PATCH(req(url, 'PATCH', { id, meetingId }));
    expect(res.status).toBe(204);
    const row = await getElection(id);
    expect(row.meetingId).toBe(meetingId);
  });

  it('DELETE removes a draft election', async () => {
    const id = await createElection();
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const row = await getElection(id);
    expect(row).toBeUndefined();
  });

  it('DELETE refuses a closed election with 409, naming closed', async () => {
    const id = await createElection({ status: 'closed' });
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already closed/i);
    const row = await getElection(id);
    expect(row).toBeDefined();
  });

  it('DELETE refuses a certified election with 409, naming certified', async () => {
    const id = await createElection();
    await getDb(env)
      .update(elections)
      .set({ status: 'certified' })
      .where(eq(elections.id, id));
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already certified/i);
    const row = await getElection(id);
    expect(row).toBeDefined();
  });

  it('DELETE refuses a void election with 409, naming void', async () => {
    const id = await createElection({ status: 'void' });
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already void/i);
    const row = await getElection(id);
    expect(row).toBeDefined();
  });

  it('GET returns elections via fetchAdminElections', async () => {
    await createElection({ title: 'Listed Election' });
    const res = await GET(req(url, 'GET'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { title: string }[];
    expect(rows.some((r) => r.title === 'Listed Election')).toBe(true);
  });
});
