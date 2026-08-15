import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { sql, eq } from 'drizzle-orm';
import { POST } from '../../src/pages/api/admin/elections';
import { getDb } from '../../src/server/db/client';
import { elections, candidates, properties } from '../../src/server/db/schema';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  ownerships,
  boardServiceTerms,
  boardOfficeAssignments,
  accessGrants,
} from '../../src/server/db/roster-schema';
import { pauseNextBatch } from './fixtures';
import { legacyAuthContext } from '../../src/server/authz/context';

/**
 * #218's certification rework (#203): certify creates PARTY-ROSTER facts —
 * board_service_terms with election provenance, optional office assignments —
 * under the qualification and non-overlap gates, all-or-nothing; and
 * uncertify VOIDS the terms it created rather than deleting them, so the
 * round-trip leaves the reversed certification visible as voided rows.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const CLEAR = [
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'board_service_change_subjects',
  'roster_change_subjects',
  'board_service_changes',
  'roster_changes',
  'access_events',
  'audit_events',
  'access_grants',
  'board_office_assignments',
  'board_service_terms',
  'ownerships',
  'people',
  'parties',
  'ballots',
  'candidates',
  'elections',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    if (table === 'audit_events') {
      await db.run(
        sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
      );
    }
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.run(sql.raw('DELETE FROM properties'));
  await db.run(sql.raw('DELETE FROM users'));
  const now = new Date();
  await db.insert(users).values({
    id: 'b',
    name: 'b',
    email: 'b@example.test',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
});

const url = 'http://localhost/api/admin/elections';
const now = new Date();

function req(method: string, body?: unknown) {
  return {
    request: new Request(url, {
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
  fullName: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb(env).insert(candidates).values({
    id,
    electionId,
    fullName,
    sequence,
    createdAt: now,
  });
  return id;
}

async function seedQualifiedPerson(personId: string, lotId: string) {
  const db = getDb(env);
  const existing = await db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, lotId));
  if (existing.length === 0)
    await db.insert(properties).values({
      id: lotId,
      address: `${lotId} Ashebrook Lane`,
      addressNormalized: `${lotId} ashebrook lane`,
      status: 'active',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
  await db
    .insert(parties)
    .values({ id: personId, kind: 'person', createdAt: now, updatedAt: now });
  await db.insert(people).values({
    partyId: personId,
    partyKind: 'person',
    fullName: `Person ${personId}`,
    nameNormalized: `person ${personId}`,
    updatedAt: now,
  });
  await db.insert(ownerships).values({
    id: `own-${personId}-${lotId}`,
    ownerPartyId: personId,
    lotId,
    startDay: '2025-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

const winner = (
  candidateId: string,
  personId: string,
  qualifyingLotId: string,
  extra: Record<string, unknown> = {},
) => ({
  candidateId,
  personId,
  qualifyingLotId,
  startDay: '2026-03-02',
  scheduledEndDay: '2027-03-02',
  ...extra,
});

describe('certify', () => {
  it('creates provenance-stamped terms, marks winners, and records one ledger root', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1, 'Avery Winner');
    const c2 = await createCandidate(electionId, 2, 'Blake Winner');
    await seedQualifiedPerson('per-1', 'lot-1');
    await seedQualifiedPerson('per-2', 'lot-2');

    const res = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [
          winner(c1, 'per-1', 'lot-1', { office: 'president' }),
          winner(c2, 'per-2', 'lot-2'),
        ],
      }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [election] = await db
      .select()
      .from(elections)
      .where(eq(elections.id, electionId));
    expect(election.status).toBe('certified');

    const terms = await db.select().from(boardServiceTerms);
    expect(terms).toHaveLength(2);
    for (const t of terms) {
      expect(t.electionId).toBe(electionId);
      expect(t.voidedAt).toBeNull();
      expect(t.scheduledEndDay).toBe('2027-03-02');
    }

    const offices = await db.select().from(boardOfficeAssignments);
    expect(offices).toHaveLength(1);
    expect(offices[0].office).toBe('president');

    const won = await db
      .select({ won: candidates.won })
      .from(candidates)
      .where(eq(candidates.electionId, electionId));
    expect(won.every((c) => c.won)).toBe(true);

    const subjects = await db.all<{ role: string }>(
      sql`SELECT s.role FROM board_service_change_subjects s
          JOIN audit_events e ON e.id = s.event_id
          WHERE e.event_kind = 'election_certified'`,
    );
    expect(subjects.filter((s) => s.role === 'created')).toHaveLength(2);
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
    expect(
      await db.all(sql`SELECT * FROM board_eligibility_violations_v`),
    ).toEqual([]);
  });

  it('refuses a winner who does not own or represent the lot, atomically', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1, 'Avery Winner');
    const c2 = await createCandidate(electionId, 2, 'Casey Unqualified');
    await seedQualifiedPerson('per-1', 'lot-1');
    await seedQualifiedPerson('per-2', 'lot-2');
    // per-2 will claim lot-1, which they neither own nor represent.
    const res = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner(c1, 'per-1', 'lot-1'), winner(c2, 'per-2', 'lot-1')],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Casey Unqualified');

    const db = getDb(env);
    expect(await db.select().from(boardServiceTerms)).toEqual([]);
    const [election] = await db
      .select()
      .from(elections)
      .where(eq(elections.id, electionId));
    expect(election.status).toBe('closed');
    expect(await db.all(sql`SELECT * FROM audit_events`)).toEqual([]);
  });

  it('refuses a winner with no roster person, naming the escape', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1, 'Newcomer Nan');
    await seedQualifiedPerson('per-x', 'lot-1');
    const res = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [
          {
            candidateId: c1,
            qualifyingLotId: 'lot-1',
            startDay: '2026-03-02',
            scheduledEndDay: '2027-03-02',
          },
        ],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      'record the ownership or representation first',
    );
  });

  it('refuses a lot already qualifying another current board member', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1, 'Avery Winner');
    await seedQualifiedPerson('per-1', 'lot-1');
    await seedQualifiedPerson('per-2', 'lot-1');
    const db = getDb(env);
    await db.insert(boardServiceTerms).values({
      id: 'term-existing',
      personId: 'per-2',
      qualifyingLotId: 'lot-1',
      startDay: '2026-01-01',
      scheduledEndDay: '2027-01-01',
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner(c1, 'per-1', 'lot-1')],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(
      'already qualifies another board member',
    );
  });

  it('fails the whole certification when a requested office is taken', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1, 'Avery Winner');
    await seedQualifiedPerson('per-1', 'lot-1');
    await seedQualifiedPerson('per-2', 'lot-2');
    const db = getDb(env);
    await db.insert(boardServiceTerms).values({
      id: 'term-2',
      personId: 'per-2',
      qualifyingLotId: 'lot-2',
      startDay: '2026-01-01',
      scheduledEndDay: '2027-01-01',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(boardOfficeAssignments).values({
      id: 'office-2',
      boardTermId: 'term-2',
      personId: 'per-2',
      office: 'president',
      startDay: '2026-01-02',
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner(c1, 'per-1', 'lot-1', { office: 'president' })],
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('That office already has a current holder');
    expect(await db.select().from(boardServiceTerms)).toHaveLength(1);
    const [election] = await db
      .select()
      .from(elections)
      .where(eq(elections.id, electionId));
    expect(election.status).toBe('closed');
  });

  it('keeps the structural ladder: unknown, withdrawn, overfilled, duplicated', async () => {
    const electionId = await createElection({ seats: 1 });
    const c1 = await createCandidate(electionId, 1, 'Avery Winner');
    await seedQualifiedPerson('per-1', 'lot-1');

    const unknown = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner('nope', 'per-1', 'lot-1')],
      }),
    );
    expect(unknown.status).toBe(400);

    await getDb(env)
      .update(candidates)
      .set({ withdrawn: true })
      .where(eq(candidates.id, c1));
    const withdrawn = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner(c1, 'per-1', 'lot-1')],
      }),
    );
    expect(withdrawn.status).toBe(400);
    await getDb(env)
      .update(candidates)
      .set({ withdrawn: false })
      .where(eq(candidates.id, c1));

    const c2 = await createCandidate(electionId, 2, 'Too Many');
    const overfilled = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner(c1, 'per-1', 'lot-1'), winner(c2, 'per-1', 'lot-1')],
      }),
    );
    expect(overfilled.status).toBe(400);
    expect(await overfilled.text()).toBe('More winners than seats');

    const missingLot = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [
          {
            candidateId: c1,
            personId: 'per-1',
            startDay: '2026-03-02',
            scheduledEndDay: '2027-03-02',
          },
        ],
      }),
    );
    expect(missingLot.status).toBe(400);
    expect(await missingLot.text()).toBe('Each winner needs a qualifyingLotId');
  });

  it('loses the race to a competing terminal transition', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1, 'Avery Winner');
    await seedQualifiedPerson('per-1', 'lot-1');
    const pause = pauseNextBatch();
    try {
      const certifyPromise = POST(
        req('POST', {
          action: 'certify',
          id: electionId,
          winners: [winner(c1, 'per-1', 'lot-1')],
        }),
      );
      await pause.reached;
      // Void wins the race while certify's batch is parked.
      const voided = await POST(
        req('POST', { action: 'void', id: electionId }),
      );
      expect(voided.status).toBe(204);
      pause.release();
      const res = await certifyPromise;
      expect(res.status).toBe(409);
    } finally {
      pause.restore();
    }
    const db = getDb(env);
    expect(await db.select().from(boardServiceTerms)).toEqual([]);
    const [election] = await db
      .select()
      .from(elections)
      .where(eq(elections.id, electionId));
    expect(election.status).toBe('void');
  });
});

describe('uncertify', () => {
  it('voids the terms it created — the round-trip leaves visible voided facts', async () => {
    const electionId = await createElection();
    const c1 = await createCandidate(electionId, 1, 'Avery Winner');
    await seedQualifiedPerson('per-1', 'lot-1');
    const certified = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner(c1, 'per-1', 'lot-1', { office: 'president' })],
      }),
    );
    expect(certified.status).toBe(204);

    // A grant qualified by the created term, to prove uncertify ends it.
    const db = getDb(env);
    const [term] = await db.select().from(boardServiceTerms);
    await db.insert(accessGrants).values({
      id: 'grant-1',
      accountId: 'b',
      grantType: 'board',
      qualifyingBoardTermId: term.id,
      startedAt: new Date(),
      grantReason: 'board_service',
    });

    const res = await POST(
      req('POST', { action: 'uncertify', id: electionId }),
    );
    expect(res.status).toBe(204);

    const [after] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, term.id));
    expect(after).toBeDefined();
    expect(after.voidedAt).not.toBeNull();
    const [office] = await db.select().from(boardOfficeAssignments);
    expect(office.voidedAt).not.toBeNull();
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'grant-1'));
    expect(grant.endedAt).not.toBeNull();
    expect(grant.endReason).toBe('recorded_in_error');

    const [election] = await db
      .select()
      .from(elections)
      .where(eq(elections.id, electionId));
    expect(election.status).toBe('closed');
    expect(election.certifiedAt).toBeNull();
    const [candidate] = await db
      .select()
      .from(candidates)
      .where(eq(candidates.id, c1));
    expect(candidate.won).toBe(false);

    const kinds = await db.all<{ event_kind: string }>(
      sql`SELECT event_kind FROM audit_events`,
    );
    expect(kinds.map((k) => k.event_kind)).toContain('election_uncertified');
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);

    // A re-certification of the same winner works: the voided term is out of
    // every overlap check.
    const again = await POST(
      req('POST', {
        action: 'certify',
        id: electionId,
        winners: [winner(c1, 'per-1', 'lot-1')],
      }),
    );
    expect(again.status).toBe(204);
  });

  it('uncertifies a legacy-certified election that has no roster terms', async () => {
    const electionId = await createElection({
      status: 'certified',
      certifiedAt: now,
      certifiedBy: 'b',
    });
    const res = await POST(
      req('POST', { action: 'uncertify', id: electionId }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [election] = await db
      .select()
      .from(elections)
      .where(eq(elections.id, electionId));
    expect(election.status).toBe('closed');
  });

  it('refuses a non-certified election', async () => {
    const electionId = await createElection();
    const res = await POST(
      req('POST', { action: 'uncertify', id: electionId }),
    );
    expect(res.status).toBe(409);
  });
});
