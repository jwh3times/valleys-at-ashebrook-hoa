import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { POST, PATCH, DELETE } from '../../src/pages/api/admin/candidates';
import { getDb } from '../../src/server/db/client';
import {
  elections,
  candidates,
  boardPeople,
  boardTerms,
} from '../../src/server/db/schema';
import { parties, people } from '../../src/server/db/roster-schema';
import { eq } from 'drizzle-orm';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(boardTerms);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(boardPeople);
  await db.delete(people);
  await db.delete(parties);
});

const url = 'http://localhost/api/admin/candidates';
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

async function createCandidateRow(
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
      personId: null,
      createdAt: now,
      ...overrides,
    });
  return id;
}

/** A roster Person — what `candidates.person_id` references since #248. */
async function createPerson(fullName: string): Promise<string> {
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
  return id;
}

async function getCandidate(id: string) {
  const rows = await getDb(env)
    .select()
    .from(candidates)
    .where(eq(candidates.id, id));
  return rows[0];
}

async function postJson(id: string) {
  return POST(req(url, 'POST', { electionId: id, fullName: 'A. Reyes' }));
}

describe('candidates admin route — board', () => {
  it('creates a candidate with a server-assigned sequence', async () => {
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', { electionId, fullName: 'A. Reyes' }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getCandidate(id);
    expect(row.sequence).toBe(1);
    expect(row.fullName).toBe('A. Reyes');
    expect(row.withdrawn).toBe(false);
    expect(row.won).toBe(false);
    expect(row.votes).toBeNull();
  });

  it('assigns the next sequence within the election', async () => {
    const electionId = await createElection();
    const c1 = await POST(req(url, 'POST', { electionId, fullName: 'A' }));
    const id1 = ((await c1.json()) as { id: string }).id;
    const c2 = await POST(req(url, 'POST', { electionId, fullName: 'B' }));
    const id2 = ((await c2.json()) as { id: string }).id;
    expect((await getCandidate(id1)).sequence).toBe(1);
    expect((await getCandidate(id2)).sequence).toBe(2);
  });

  it('scopes sequence numbering per election, not globally', async () => {
    const electionA = await createElection();
    const electionB = await createElection({ title: 'Other election' });
    const a1 = (
      (await (await postJson(electionA)).json()) as {
        id: string;
      }
    ).id;
    const b1 = (
      (await (await postJson(electionB)).json()) as {
        id: string;
      }
    ).id;
    const a2 = (
      (await (await postJson(electionA)).json()) as {
        id: string;
      }
    ).id;
    expect((await getCandidate(a1)).sequence).toBe(1);
    expect((await getCandidate(a2)).sequence).toBe(2);
    expect((await getCandidate(b1)).sequence).toBe(1);
  });

  it('creating against a nonexistent election returns 404', async () => {
    const res = await POST(
      req(url, 'POST', { electionId: 'nope', fullName: 'A' }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/election not found/i);
  });

  it('rejects a create against a certified election with 409', async () => {
    const electionId = await createElection({ status: 'certified' });
    const res = await POST(req(url, 'POST', { electionId, fullName: 'A' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
    const rows = await getDb(env)
      .select()
      .from(candidates)
      .where(eq(candidates.electionId, electionId));
    expect(rows.length).toBe(0);
  });

  it('rejects a create against a void election with 409', async () => {
    const electionId = await createElection({ status: 'void' });
    const res = await POST(req(url, 'POST', { electionId, fullName: 'A' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
  });

  it('rejects a create once an election is no longer a draft', async () => {
    for (const status of ['open', 'closed'] as const) {
      const electionId = await createElection({
        source: status === 'open' ? 'conducted' : 'recorded',
        status,
      });

      const res = await POST(req(url, 'POST', { electionId, fullName: 'A' }));

      expect(res.status).toBe(409);
      const rows = await getDb(env)
        .select()
        .from(candidates)
        .where(eq(candidates.electionId, electionId));
      expect(rows).toEqual([]);
    }
  });

  it('rejects a create with an unknown personId with 400', async () => {
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', {
        electionId,
        fullName: 'A',
        personId: 'nope',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown personid/i);
    const rows = await getDb(env)
      .select()
      .from(candidates)
      .where(eq(candidates.electionId, electionId));
    expect(rows.length).toBe(0);
  });

  it('creates a candidate linked to an existing roster Person', async () => {
    const electionId = await createElection();
    const personId = await createPerson('Incumbent Person');
    const res = await POST(
      req(url, 'POST', {
        electionId,
        fullName: 'Incumbent Person',
        personId: personId,
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await getCandidate(id)).personId).toBe(personId);
  });

  it('rejects a create carrying sequence, with 400', async () => {
    const electionId = await createElection();
    const res = await POST(
      req(url, 'POST', {
        electionId,
        fullName: 'A',
        sequence: 5,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/sequence is not editable/i);
  });

  it('PATCH updates fullName and marks a candidate withdrawn', async () => {
    const electionId = await createElection();
    const id = await createCandidateRow(electionId, 1);
    const res = await PATCH(
      req(url, 'PATCH', { id, fullName: 'Updated Name', withdrawn: true }),
    );
    expect(res.status).toBe(204);
    const row = await getCandidate(id);
    expect(row.fullName).toBe('Updated Name');
    expect(row.withdrawn).toBe(true);
  });

  it('PATCH cannot move a candidate to another election', async () => {
    const electionA = await createElection();
    const electionB = await createElection({ title: 'Other' });
    const id = await createCandidateRow(electionA, 1);
    const res = await PATCH(
      req(url, 'PATCH', { id, electionId: electionB, fullName: 'Still here' }),
    );
    expect(res.status).toBe(204);
    const row = await getCandidate(id);
    expect(row.electionId).toBe(electionA);
    expect(row.fullName).toBe('Still here');
  });

  it('PATCH on a nonexistent candidate returns 404', async () => {
    const res = await PATCH(req(url, 'PATCH', { id: 'nope', fullName: 'X' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/candidate not found/i);
  });

  it('PATCH on a candidate in a certified election returns 409', async () => {
    const electionId = await createElection({ status: 'certified' });
    const id = await createCandidateRow(electionId, 1);
    const res = await PATCH(req(url, 'PATCH', { id, fullName: 'X' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
    const row = await getCandidate(id);
    expect(row.fullName).not.toBe('X');
  });

  it('PATCH on a candidate in a void election returns 409', async () => {
    const electionId = await createElection({ status: 'void' });
    const id = await createCandidateRow(electionId, 1);
    const res = await PATCH(req(url, 'PATCH', { id, fullName: 'X' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/certified or void/i);
  });

  it('PATCH on an open conducted election permits only the first withdrawal', async () => {
    const electionId = await createElection({
      source: 'conducted',
      status: 'open',
    });
    const candidateId = await createCandidateRow(electionId, 1);
    const patchCandidate = async (
      payload: Record<string, unknown>,
    ): Promise<number> =>
      (await PATCH(req(url, 'PATCH', { id: candidateId, ...payload }))).status;

    expect(await patchCandidate({ withdrawn: true })).toBe(204);
    expect(await patchCandidate({ withdrawn: false })).toBe(409);
    expect(await patchCandidate({ fullName: 'Changed' })).toBe(409);
    expect(await patchCandidate({ withdrawn: true })).toBe(409);
    expect(await getCandidate(candidateId)).toMatchObject({
      fullName: 'Candidate 1',
      withdrawn: true,
    });
  });

  it('PATCH freezes a conducted candidate after the election closes', async () => {
    const electionId = await createElection({
      source: 'conducted',
      status: 'closed',
    });
    const candidateId = await createCandidateRow(electionId, 1);

    const res = await PATCH(
      req(url, 'PATCH', { id: candidateId, fullName: 'Changed' }),
    );

    expect(res.status).toBe(409);
    expect((await getCandidate(candidateId)).fullName).toBe('Candidate 1');
  });

  it('PATCH with no fields to update returns 400', async () => {
    const electionId = await createElection();
    const id = await createCandidateRow(electionId, 1);
    const res = await PATCH(req(url, 'PATCH', { id }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/no fields to update/i);
  });

  it('PATCH rejects an unknown personId with 400', async () => {
    const electionId = await createElection();
    const id = await createCandidateRow(electionId, 1);
    const res = await PATCH(req(url, 'PATCH', { id, personId: 'nope' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown personid/i);
  });

  it('PATCH rejects sequence with 400', async () => {
    const electionId = await createElection();
    const id = await createCandidateRow(electionId, 1);
    const res = await PATCH(req(url, 'PATCH', { id, sequence: 5 }));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/sequence is not editable/i);
  });

  it('DELETE removes a candidate from a draft election', async () => {
    const electionId = await createElection();
    const id = await createCandidateRow(electionId, 1);
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    expect(await getCandidate(id)).toBeUndefined();
  });

  it('DELETE refuses a candidate on a closed election with 409', async () => {
    const electionId = await createElection({ status: 'closed' });
    const id = await createCandidateRow(electionId, 1);
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/mark them withdrawn/i);
    expect(await getCandidate(id)).toBeDefined();
  });

  it('DELETE refuses a candidate on a certified election with 409', async () => {
    const electionId = await createElection({ status: 'certified' });
    const id = await createCandidateRow(electionId, 1);
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await getCandidate(id)).toBeDefined();
  });

  it('DELETE on a nonexistent candidate returns 404', async () => {
    const res = await DELETE(req(url, 'DELETE', { id: 'nope' }));
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/candidate not found/i);
  });
});
