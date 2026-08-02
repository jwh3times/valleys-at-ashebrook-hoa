import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/elections';
import { getDb } from '../../src/server/db/client';
import {
  elections,
  candidates,
  ballots,
  properties,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(ballots);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(properties);
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

  it('rejects a create carrying source, with 400', async () => {
    const res = await POST(
      req(url, 'POST', {
        title: 'X',
        seats: 2,
        electionDate: '2026-03-01',
        source: 'conducted',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/source is not editable/i);
    const rows = await getDb(env)
      .select()
      .from(elections)
      .where(eq(elections.title, 'X'));
    expect(rows.length).toBe(0);
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

  it('PATCH on a nonexistent election returns 404', async () => {
    const res = await PATCH(req(url, 'PATCH', { id: 'nope', title: 'X' }));
    expect(res.status).toBe(404);
  });

  it('DELETE removes a draft election', async () => {
    const id = await createElection();
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const row = await getElection(id);
    expect(row).toBeUndefined();
  });

  it('DELETE refuses a closed election with 409', async () => {
    const id = await createElection({ status: 'closed' });
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/part of the record/i);
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
