import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST, DELETE } from '../../src/pages/api/admin/elections';
import { getDb } from '../../src/server/db/client';
import {
  elections,
  candidates,
  ballots,
  boardPeople,
  boardTerms,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  // Delete order respects the FK graph: board_terms references both
  // board_people (restrict) and elections (NO ACTION in practice — see the
  // schema comment on boardTerms.electionId), and candidates references
  // board_people (restrict), so both must go before board_people/elections.
  await db.delete(boardTerms);
  await db.delete(ballots);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(boardPeople);
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
      status: 'closed',
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
      boardPersonId: null,
      createdAt: now,
      ...overrides,
    });
  return id;
}

async function createBoardPerson(
  fullName: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(boardPeople)
    .values({ id, fullName, createdAt: now, updatedAt: now, ...overrides });
  return id;
}

async function createBoardTerm(
  personId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(boardTerms)
    .values({
      id,
      personId,
      title: null,
      termStart: '2020-01-01',
      termEnd: null,
      electionId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
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

async function getPerson(id: string) {
  const rows = await getDb(env)
    .select()
    .from(boardPeople)
    .where(eq(boardPeople.id, id));
  return rows[0];
}

async function getTermsFor(electionId: string) {
  return getDb(env)
    .select()
    .from(boardTerms)
    .where(eq(boardTerms.electionId, electionId));
}

describe('elections admin route — certify/uncertify', () => {
  it('certify moves closed to certified and marks the winners', async () => {
    const electionId = await createElection({ seats: 2 });
    const c1 = await createCandidate(electionId, 1);
    const c2 = await createCandidate(electionId, 2);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(204);
    const election = await getElection(electionId);
    expect(election.status).toBe('certified');
    expect(election.certifiedAt).toBeInstanceOf(Date);
    expect(election.certifiedBy).toBe('b');
    expect((await getCandidate(c1)).won).toBe(true);
    expect((await getCandidate(c2)).won).toBe(false);
  });

  it('certify creates a board person for a winner who had none', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(204);
    const candidate = await getCandidate(c1);
    expect(candidate.boardPersonId).not.toBeNull();
    const person = await getPerson(candidate.boardPersonId!);
    expect(person.fullName).toBe('Candidate 1');
  });

  it("certify BACKFILLS the candidate's board_person_id with the created person", async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    expect((await getCandidate(c1)).boardPersonId).toBeNull();
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    const candidate = await getCandidate(c1);
    expect(candidate.boardPersonId).not.toBeNull();
    const terms = await getTermsFor(electionId);
    expect(terms[0].personId).toBe(candidate.boardPersonId);
  });

  it('certify opens one term per winner, stamped with the election id', async () => {
    const electionId = await createElection({ seats: 2 });
    const c1 = await createCandidate(electionId, 1);
    const c2 = await createCandidate(electionId, 2);
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [
          { candidateId: c1, termStart: '2026-01-01' },
          { candidateId: c2, termStart: '2026-01-01' },
        ],
      }),
    );
    const terms = await getTermsFor(electionId);
    expect(terms.length).toBe(2);
    for (const term of terms) expect(term.electionId).toBe(electionId);
  });

  it('certify uses the per-winner term start, not a shared one', async () => {
    const electionId = await createElection({ seats: 2 });
    const c1 = await createCandidate(electionId, 1);
    const c2 = await createCandidate(electionId, 2);
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [
          { candidateId: c1, termStart: '2026-01-01' },
          { candidateId: c2, termStart: '2026-06-01' },
        ],
      }),
    );
    const terms = await getTermsFor(electionId);
    const p1 = (await getCandidate(c1)).boardPersonId;
    const p2 = (await getCandidate(c2)).boardPersonId;
    expect(terms.find((t) => t.personId === p1)!.termStart).toBe('2026-01-01');
    expect(terms.find((t) => t.personId === p2)!.termStart).toBe('2026-06-01');
  });

  it('certify records an optional term end and title', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [
          {
            candidateId: c1,
            termStart: '2026-01-01',
            termEnd: '2028-01-01',
            title: 'President',
          },
        ],
      }),
    );
    const terms = await getTermsFor(electionId);
    expect(terms[0].termEnd).toBe('2028-01-01');
    expect(terms[0].title).toBe('President');
  });

  it('certify on a draft election returns 409', async () => {
    const electionId = await createElection({ seats: 1, status: 'draft' });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/close the election before certifying/i);
    expect((await getElection(electionId)).status).toBe('draft');
  });

  it('certify on an already-certified election returns 409', async () => {
    const electionId = await createElection({ seats: 1, status: 'certified' });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/close the election before certifying/i);
  });

  it('certify with more winners than seats returns 400', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    const c2 = await createCandidate(electionId, 2);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [
          { candidateId: c1, termStart: '2026-01-01' },
          { candidateId: c2, termStart: '2026-01-01' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/more winners than seats/i);
    expect((await getElection(electionId)).status).toBe('closed');
  });

  it('certify with fewer winners than seats succeeds', async () => {
    const electionId = await createElection({ seats: 2 });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(204);
    expect((await getElection(electionId)).status).toBe('certified');
    expect((await getCandidate(c1)).won).toBe(true);
  });

  it('certify naming a withdrawn candidate returns 400', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1, { withdrawn: true });
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/withdrawn candidate/i);
    expect((await getElection(electionId)).status).toBe('closed');
    expect((await getCandidate(c1)).won).toBe(false);
  });

  it('certify naming a candidate from another election returns 400', async () => {
    const electionId = await createElection({ seats: 1 });
    const otherElectionId = await createElection({
      seats: 1,
      title: 'Other',
    });
    const foreign = await createCandidate(otherElectionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: foreign, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown candidate/i);
    expect((await getElection(electionId)).status).toBe('closed');
  });

  it('certify naming the same candidate twice returns 400', async () => {
    const electionId = await createElection({ seats: 2 });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [
          { candidateId: c1, termStart: '2026-01-01' },
          { candidateId: c1, termStart: '2026-01-01' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/same candidate cannot win twice/i);
    expect((await getElection(electionId)).status).toBe('closed');
  });

  it('certify with a malformed termStart returns 400', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '01/01/2026' }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/termStart must be YYYY-MM-DD/i);
    expect((await getElection(electionId)).status).toBe('closed');
  });

  it('certify with a termEnd before its termStart returns 400', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [
          {
            candidateId: c1,
            termStart: '2026-01-01',
            termEnd: '2025-01-01',
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/termEnd must not be before termStart/i);
    expect((await getElection(electionId)).status).toBe('closed');
  });

  it('certify refuses a winner who already holds an open term, naming them', async () => {
    const electionId = await createElection({ seats: 1 });
    const personId = await createBoardPerson('Incumbent Person');
    await createBoardTerm(personId, { termEnd: null });
    const c1 = await createCandidate(electionId, 1, {
      fullName: 'Incumbent Person',
      boardPersonId: personId,
    });
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(
      /Incumbent Person already holds an open term/,
    );
    expect((await getElection(electionId)).status).toBe('closed');
    expect((await getCandidate(c1)).won).toBe(false);
  });

  it('certify refuses two winners resolving to the same board person, with 400', async () => {
    const electionId = await createElection({ seats: 2 });
    const personId = await createBoardPerson('Shared Person');
    // No existing term — both winners would otherwise pass the open-term
    // check individually, since neither holds a term *yet*.
    const c1 = await createCandidate(electionId, 1, {
      fullName: 'Shared Person A',
      boardPersonId: personId,
    });
    const c2 = await createCandidate(electionId, 2, {
      fullName: 'Shared Person B',
      boardPersonId: personId,
    });
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [
          { candidateId: c1, termStart: '2026-01-01' },
          { candidateId: c2, termStart: '2026-01-01' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(
      /two winners resolve to the same board person/i,
    );
    expect((await getElection(electionId)).status).toBe('closed');
    expect((await getTermsFor(electionId)).length).toBe(0);
  });

  it('uncertify removes the terms it created and clears won', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect((await getTermsFor(electionId)).length).toBe(1);
    const res = await POST(
      req(url, 'POST', { action: 'uncertify', id: electionId }),
    );
    expect(res.status).toBe(204);
    // One-batch property: assert both the roster rows AND the status flip
    // in this same test, against the same certify/uncertify round trip.
    expect((await getTermsFor(electionId)).length).toBe(0);
    expect((await getCandidate(c1)).won).toBe(false);
    const election = await getElection(electionId);
    expect(election.status).toBe('closed');
    expect(election.certifiedAt).toBeNull();
    expect(election.certifiedBy).toBeNull();
  });

  it('uncertify leaves the board_people rows intact', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    const personId = (await getCandidate(c1)).boardPersonId!;
    expect(await getPerson(personId)).toBeDefined();
    await POST(req(url, 'POST', { action: 'uncertify', id: electionId }));
    expect(await getPerson(personId)).toBeDefined();
  });

  it('uncertify on a closed election returns 409', async () => {
    const electionId = await createElection({ seats: 1 });
    const res = await POST(
      req(url, 'POST', { action: 'uncertify', id: electionId }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/only a certified election/i);
    expect((await getElection(electionId)).status).toBe('closed');
  });

  it('a certified election refuses setTallies, setBallots, and DELETE', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    const tallies = await POST(
      req(url, 'POST', {
        action: 'setTallies',
        electionId,
        entries: [{ candidateId: c1, votes: 1 }],
      }),
    );
    expect(tallies.status).toBe(409);
    expect(await tallies.text()).toMatch(/certified or void/i);

    const ballotsRes = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId,
        entries: [],
      }),
    );
    expect(ballotsRes.status).toBe(409);
    expect(await ballotsRes.text()).toMatch(/certified or void/i);

    const del = await DELETE(req(url, 'DELETE', { id: electionId }));
    expect(del.status).toBe(409);
    expect(await del.text()).toMatch(/already certified/i);
  });
});
