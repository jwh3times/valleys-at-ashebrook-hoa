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
const originalD1Batch = env.DATABASE.batch.bind(env.DATABASE);

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

function pauseNextBatch() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batchReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let paused = false;
  const spy = vi
    .spyOn(env.DATABASE, 'batch')
    .mockImplementation(async (statements) => {
      if (!paused) {
        paused = true;
        reached();
        await released;
      }
      return originalD1Batch(statements);
    });
  return {
    reached: batchReached,
    release,
    restore: () => spy.mockRestore(),
  };
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
    // One-batch property: the status flip alone is not enough — a batch that
    // flipped status but skipped the term insert must also fail this test.
    expect((await getTermsFor(electionId)).length).toBe(1);
  });

  it('void racing certify leaves exactly one complete terminal state', async () => {
    const electionId = await createElection({ seats: 1 });
    const candidateId = await createCandidate(electionId, 1);
    const certifyPromise = POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId, termStart: '2026-01-01' }],
      }),
    );

    // Let certification clear its status preflight before the conflicting
    // terminal transition is queued.
    await Promise.resolve();
    await env.DATABASE.prepare('SELECT 1').first();
    const voidPromise = POST(
      req(url, 'POST', { action: 'void', id: electionId }),
    );
    const [certifyResponse, voidResponse] = await Promise.all([
      certifyPromise,
      voidPromise,
    ]);

    expect(
      [certifyResponse.status, voidResponse.status].sort((a, b) => a - b),
    ).toEqual([204, 409]);
    const election = await getElection(electionId);
    const candidate = await getCandidate(candidateId);
    const terms = await getTermsFor(electionId);
    if (election.status === 'certified') {
      expect(certifyResponse.status).toBe(204);
      expect(voidResponse.status).toBe(409);
      expect(election.certifiedAt).toBeInstanceOf(Date);
      expect(election.certifiedBy).toBe('b');
      expect(candidate.won).toBe(true);
      expect(candidate.boardPersonId).not.toBeNull();
      expect(terms).toHaveLength(1);
    } else {
      expect(election.status).toBe('void');
      expect(voidResponse.status).toBe(204);
      expect(certifyResponse.status).toBe(409);
      expect(election.certifiedAt).toBeNull();
      expect(election.certifiedBy).toBeNull();
      expect(candidate.won).toBe(false);
      expect(candidate.boardPersonId).toBeNull();
      expect(terms).toHaveLength(0);
    }
  });

  it('does not replace tallies after a concurrent certification commits', async () => {
    const electionId = await createElection({ seats: 1 });
    const candidateId = await createCandidate(electionId, 1);
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setTallies',
            electionId,
            entries: [{ candidateId, votes: 7 }],
          }),
        )
      ).status,
    ).toBe(204);

    const barrier = pauseNextBatch();
    try {
      const replacementPromise = POST(
        req(url, 'POST', {
          action: 'setTallies',
          electionId,
          entries: [{ candidateId, votes: 99 }],
        }),
      );
      await barrier.reached;
      expect(
        (
          await POST(
            req(url, 'POST', {
              action: 'certify',
              id: electionId,
              winners: [{ candidateId, termStart: '2026-01-01' }],
            }),
          )
        ).status,
      ).toBe(204);
      barrier.release();
      expect((await replacementPromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }

    expect((await getElection(electionId)).status).toBe('certified');
    const candidate = await getCandidate(candidateId);
    expect(candidate.votes).toBe(7);
    expect(candidate.won).toBe(true);
    expect(await getTermsFor(electionId)).toHaveLength(1);
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

  it('certify on a draft election with a malformed termStart still returns 409 close-first, not 400', async () => {
    // Precondition ordering collision: status (2) must be checked before
    // date validation (6). A malformed termStart on a draft election must
    // still report "close it first," not the date error.
    const electionId = await createElection({ seats: 1, status: 'draft' });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: 'not-a-date' }],
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

  it('certify with an empty winners array returns 400', async () => {
    const electionId = await createElection({ seats: 2 });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/winners must be a non-empty array/i);
    expect((await getElection(electionId)).status).toBe('closed');
    expect((await getCandidate(c1)).won).toBe(false);
  });

  it('certify on a void election returns 409, naming void rather than close-first advice', async () => {
    const electionId = await createElection({ seats: 1, status: 'void' });
    const c1 = await createCandidate(electionId, 1);
    const res = await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/cannot certify a void election/i);
    expect((await getElection(electionId)).status).toBe('void');
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

  it('certify with a malformed termEnd returns 400', async () => {
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
            termEnd: '2028/01/01',
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/termEnd must be YYYY-MM-DD/i);
    expect((await getElection(electionId)).status).toBe('closed');
  });

  it('certify rejects a title over the length cap with 400', async () => {
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
            title: 'P'.repeat(101),
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/title must be 100 characters or fewer/i);
    expect((await getElection(electionId)).status).toBe('closed');
    expect((await getTermsFor(electionId)).length).toBe(0);
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

  it('allows only one concurrent certification to open a term for the same existing board person', async () => {
    const personId = await createBoardPerson('Shared Incumbent');
    const losingElectionId = await createElection({
      seats: 2,
      title: 'Losing election',
    });
    const sharedLosingCandidateId = await createCandidate(losingElectionId, 1, {
      fullName: 'Shared Incumbent',
      boardPersonId: personId,
    });
    const newLosingCandidateId = await createCandidate(losingElectionId, 2, {
      fullName: 'Would-be New Person',
    });
    const winningElectionId = await createElection({
      seats: 1,
      title: 'Winning election',
    });
    const winningCandidateId = await createCandidate(winningElectionId, 1, {
      fullName: 'Shared Incumbent',
      boardPersonId: personId,
    });

    const barrier = pauseNextBatch();
    try {
      const losingPromise = POST(
        req(url, 'POST', {
          action: 'certify',
          id: losingElectionId,
          winners: [
            {
              candidateId: sharedLosingCandidateId,
              termStart: '2026-01-01',
            },
            {
              candidateId: newLosingCandidateId,
              termStart: '2026-01-01',
            },
          ],
        }),
      );
      await barrier.reached;
      expect(
        (
          await POST(
            req(url, 'POST', {
              action: 'certify',
              id: winningElectionId,
              winners: [
                { candidateId: winningCandidateId, termStart: '2026-01-01' },
              ],
            }),
          )
        ).status,
      ).toBe(204);
      barrier.release();
      expect((await losingPromise).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }

    expect((await getElection(winningElectionId)).status).toBe('certified');
    expect((await getTermsFor(winningElectionId)).length).toBe(1);
    expect((await getCandidate(winningCandidateId)).won).toBe(true);

    expect((await getElection(losingElectionId)).status).toBe('closed');
    expect((await getTermsFor(losingElectionId)).length).toBe(0);
    expect((await getCandidate(sharedLosingCandidateId)).won).toBe(false);
    expect((await getCandidate(newLosingCandidateId)).won).toBe(false);
    expect((await getCandidate(newLosingCandidateId)).boardPersonId).toBeNull();
    expect(await getDb(env).select().from(boardPeople)).toHaveLength(1);
  });

  it('certify prioritizes the withdrawn check over the open-term check, with 400', async () => {
    // Precondition ordering collision: candidate validity (5, including
    // withdrawn) must be checked before the open-term lookup (8). A
    // withdrawn candidate whose linked person also holds an open term must
    // report "withdrawn," not "already holds an open term."
    const electionId = await createElection({ seats: 1 });
    const personId = await createBoardPerson('Incumbent Withdrawn');
    await createBoardTerm(personId, { termEnd: null });
    const c1 = await createCandidate(electionId, 1, {
      fullName: 'Incumbent Withdrawn',
      boardPersonId: personId,
      withdrawn: true,
    });
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

  it('certify -> uncertify -> certify reuses the same board person identity', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1);
    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-01-01' }],
      }),
    );
    const firstPersonId = (await getCandidate(c1)).boardPersonId;
    expect(firstPersonId).not.toBeNull();

    await POST(req(url, 'POST', { action: 'uncertify', id: electionId }));
    // uncertify already returns the election to 'closed', which is exactly
    // the state certify requires — no separate close step is needed.
    expect((await getElection(electionId)).status).toBe('closed');

    await POST(
      req(url, 'POST', {
        action: 'certify',
        id: electionId,
        winners: [{ candidateId: c1, termStart: '2026-02-01' }],
      }),
    );
    const secondPersonId = (await getCandidate(c1)).boardPersonId;
    expect(secondPersonId).toBe(firstPersonId);
    const terms = await getTermsFor(electionId);
    expect(terms.length).toBe(1);
    expect(terms[0].personId).toBe(firstPersonId);
    expect(terms[0].termStart).toBe('2026-02-01');
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
