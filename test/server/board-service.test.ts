import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { properties } from '../../src/server/db/schema';
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
import { GET, POST } from '../../src/pages/api/admin/board-service';
import type { BoardServiceDetail } from '../../src/server/roster/reads';

/**
 * #218's Board service lifecycle (#203): interval non-overlap per Person and
 * per qualifying Lot as conditional SQL (proven under interleaving, not just
 * sequentially), the three disjoint ending kinds and what each does to
 * offices and grants, in-place substitution with its three typed subjects,
 * and the live-derived composition advisories.
 */

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    (
      await importActual<typeof import('../../src/server/authz/context')>()
    ).legacyAuthContext('board-1', 'board', []),
}));

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const TODAY = new Date().toISOString().slice(0, 10);

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
    id: 'board-1',
    name: 'board-1',
    email: 'board-1@example.test',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
});

async function seedLot(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Ashebrook Lane`,
      addressNormalized: `${id} ashebrook lane`,
      status: 'active',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedPerson(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env)
    .insert(people)
    .values({
      partyId: id,
      partyKind: 'person',
      fullName: `Person ${id}`,
      nameNormalized: `person ${id}`,
      updatedAt: now,
    });
}

async function seedOwnership(id: string, ownerPartyId: string, lotId: string) {
  const now = new Date();
  await getDb(env).insert(ownerships).values({
    id,
    ownerPartyId,
    lotId,
    startDay: '2025-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

/** One qualified person on their own lot, ready for terms. */
async function seedQualified(person: string, lot: string) {
  await seedLot(lot);
  await seedPerson(person);
  await seedOwnership(`own-${person}-${lot}`, person, lot);
}

function req(body?: unknown, method = 'POST'): never {
  const init: RequestInit = {
    method,
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request('http://localhost/api/admin/board-service', init),
  } as never;
}

async function createTerm(
  personId: string,
  qualifyingLotId: string,
  startDay: string,
  scheduledEndDay: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return POST(
    req({
      action: 'createTerm',
      personId,
      qualifyingLotId,
      startDay,
      scheduledEndDay,
      reasonCode: 'elected',
      ...extra,
    }),
  );
}

async function integrityClean() {
  const db = getDb(env);
  expect(await db.all(sql`SELECT * FROM audit_integrity_violations_v`)).toEqual(
    [],
  );
  expect(
    await db.all(sql`SELECT * FROM board_eligibility_violations_v`),
  ).toEqual([]);
}

describe('createTerm and non-overlap', () => {
  it('creates a term with its ledger root and two subjects', async () => {
    await seedQualified('per-1', 'lot-1');
    const res = await createTerm('per-1', 'lot-1', '2026-01-01', '2027-01-01');
    expect(res.status).toBe(201);
    const db = getDb(env);
    const subjects = await db.all<{ role: string }>(
      sql`SELECT s.role FROM board_service_change_subjects s
          JOIN audit_events e ON e.id = s.event_id
          WHERE e.event_kind = 'board_term_created'`,
    );
    expect(subjects.map((s) => s.role).sort()).toEqual(['created', 'related']);
    await integrityClean();
  });

  it('allows adjacency and a current-plus-scheduled pair, refuses overlap per person', async () => {
    await seedQualified('per-1', 'lot-1');
    expect(
      (await createTerm('per-1', 'lot-1', '2026-01-01', '2026-12-01')).status,
    ).toBe(201);
    // Adjacent successor: legal — this is how renewal is recorded.
    expect(
      (await createTerm('per-1', 'lot-1', '2026-12-01', '2027-12-01')).status,
    ).toBe(201);
    // Overlapping third term: refused.
    const overlap = await createTerm(
      'per-1',
      'lot-1',
      '2027-06-01',
      '2028-06-01',
    );
    expect(overlap.status).toBe(409);
    expect(await overlap.text()).toBe(
      'Overlaps an existing term for this person',
    );
  });

  it('refuses per-lot overlap across two persons, and an unqualified person', async () => {
    await seedQualified('per-1', 'lot-1');
    await seedPerson('per-2');
    await seedOwnership('own-2', 'per-2', 'lot-1');
    expect(
      (await createTerm('per-1', 'lot-1', '2026-01-01', '2027-01-01')).status,
    ).toBe(201);
    const lotTaken = await createTerm(
      'per-2',
      'lot-1',
      '2026-06-01',
      '2027-06-01',
    );
    expect(lotTaken.status).toBe(409);
    expect(await lotTaken.text()).toBe(
      'That lot already qualifies another board member for an overlapping term',
    );

    await seedLot('lot-x');
    const unqualified = await createTerm(
      'per-2',
      'lot-x',
      '2026-06-01',
      '2027-06-01',
    );
    expect(unqualified.status).toBe(409);
    expect(await unqualified.text()).toBe(
      'Person does not currently own or represent that lot',
    );
  });

  it('holds non-overlap under interleaving: the slower batch loses at the boundary', async () => {
    await seedQualified('per-1', 'lot-1');
    const pause = pauseNextBatch();
    try {
      // A passes its readable pre-checks, then its batch parks.
      const a = createTerm('per-1', 'lot-1', '2026-01-01', '2027-01-01');
      await pause.reached;
      // B runs to completion in the window where A has decided but not
      // committed — exactly the race the in-batch guards exist for.
      const b = await createTerm('per-1', 'lot-1', '2026-06-01', '2027-06-01');
      expect(b.status).toBe(201);
      pause.release();
      const aRes = await a;
      expect(aRes.status).toBe(409);
    } finally {
      pause.restore();
    }
    const db = getDb(env);
    const terms = await db.select().from(boardServiceTerms);
    expect(terms).toHaveLength(1);
    await integrityClean();
  });
});

describe('the three ending kinds', () => {
  it('endTerm ends offices with it and ends the grant at recorded-at', async () => {
    await seedQualified('per-1', 'lot-1');
    const created = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    const termId = ((await created.json()) as { id: string }).id;
    const assigned = await POST(
      req({
        action: 'assignOffice',
        termId,
        office: 'president',
        startDay: '2026-01-02',
      }),
    );
    expect(assigned.status).toBe(201);
    await getDb(env)
      .insert(accessGrants)
      .values({
        id: 'grant-1',
        accountId: 'board-1',
        grantType: 'board',
        qualifyingBoardTermId: termId,
        startedAt: new Date('2026-01-02T00:00:00Z'),
        grantReason: 'board_service',
      });

    const before = Date.now();
    const res = await POST(
      req({
        action: 'endTerm',
        termId,
        endDay: '2026-07-01',
        reasonCode: 'resigned',
      }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, termId));
    expect(term.actualEndDay).toBe('2026-07-01');
    const [office] = await db.select().from(boardOfficeAssignments);
    expect(office.endDay).toBe('2026-07-01');
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'grant-1'));
    expect(grant.endedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(grant.endReason).toBe('term_ended');
    await integrityClean();
  });

  it('cancelTerm refuses a started term, cancels a scheduled one, voids its office', async () => {
    await seedQualified('per-1', 'lot-1');
    const started = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    const startedId = ((await started.json()) as { id: string }).id;
    const refuse = await POST(
      req({ action: 'cancelTerm', termId: startedId, reasonCode: 'resigned' }),
    );
    expect(refuse.status).toBe(409);
    expect(await refuse.text()).toBe('Term already started — end it instead');

    await seedQualified('per-2', 'lot-2');
    const scheduled = await createTerm(
      'per-2',
      'lot-2',
      '2030-01-01',
      '2031-01-01',
    );
    const scheduledId = ((await scheduled.json()) as { id: string }).id;
    const assigned = await POST(
      req({
        action: 'assignOffice',
        termId: scheduledId,
        office: 'vice_president',
        startDay: '2030-01-01',
      }),
    );
    expect(assigned.status).toBe(201);

    const res = await POST(
      req({
        action: 'cancelTerm',
        termId: scheduledId,
        reasonCode: 'resigned',
      }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, scheduledId));
    expect(term.cancelledAt).not.toBeNull();
    expect(term.cancelledDay).toBe(TODAY);
    const [office] = await db
      .select()
      .from(boardOfficeAssignments)
      .where(eq(boardOfficeAssignments.boardTermId, scheduledId));
    expect(office.voidedAt).not.toBeNull();
    await integrityClean();
  });

  it('voidTerm clears a prior ending as scalar deltas and frees the interval', async () => {
    await seedQualified('per-1', 'lot-1');
    const created = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    const termId = ((await created.json()) as { id: string }).id;
    await POST(
      req({
        action: 'endTerm',
        termId,
        endDay: '2026-07-01',
        reasonCode: 'resigned',
      }),
    );

    const res = await POST(req({ action: 'voidTerm', termId }));
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, termId));
    expect(term.voidedAt).not.toBeNull();
    expect(term.actualEndDay).toBeNull();
    const deltas = await db.all<{ field_key: string; old_day: string }>(
      sql`SELECT field_key, old_day FROM audit_scalar_changes`,
    );
    expect(deltas).toContainEqual({
      field_key: 'actual_end_day',
      old_day: '2026-07-01',
    });

    // A voided term is excluded from overlap: the same interval is free again.
    const again = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    expect(again.status).toBe(201);
    await integrityClean();
  });
});

describe('substitution and correction', () => {
  it('substitutes a validated lot with three typed subjects', async () => {
    await seedQualified('per-1', 'lot-1');
    await seedLot('lot-2');
    await seedOwnership('own-b', 'per-1', 'lot-2');
    const created = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    const termId = ((await created.json()) as { id: string }).id;

    const res = await POST(
      req({
        action: 'substituteQualifyingLot',
        termId,
        qualifyingLotId: 'lot-2',
      }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const subjects = await db.all<{
      role: string;
      lot_id: string | null;
      board_term_id: string | null;
    }>(
      sql`SELECT s.role, s.lot_id, s.board_term_id FROM board_service_change_subjects s
          JOIN audit_events e ON e.id = s.event_id
          WHERE e.event_kind = 'qualifying_lot_substituted'`,
    );
    expect(subjects).toHaveLength(3);
    expect(subjects.find((s) => s.role === 'replacement')?.lot_id).toBe(
      'lot-2',
    );
    await integrityClean();
  });

  it('refuses a substitute the person does not qualify through', async () => {
    await seedQualified('per-1', 'lot-1');
    await seedLot('lot-x');
    const created = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    const termId = ((await created.json()) as { id: string }).id;
    const res = await POST(
      req({
        action: 'substituteQualifyingLot',
        termId,
        qualifyingLotId: 'lot-x',
      }),
    );
    expect(res.status).toBe(409);
  });

  it('correctTerm records election provenance as evidence', async () => {
    await seedQualified('per-1', 'lot-1');
    const created = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    const termId = ((await created.json()) as { id: string }).id;
    const res = await POST(
      req({ action: 'correctTerm', termId, electionId: null }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [change] = await db.all<{
      reason_code: string;
      evidence_kind: string;
    }>(
      sql`SELECT bsc.reason_code, bsc.evidence_kind FROM board_service_changes bsc
          JOIN audit_events e ON e.id = bsc.event_id
          WHERE e.event_kind = 'board_term_corrected'`,
    );
    expect(change).toMatchObject({
      reason_code: 'recorded_in_error',
      evidence_kind: 'operator_observation',
    });
  });
});

describe('offices', () => {
  it('enforces one current holder per office and one office per person', async () => {
    await seedQualified('per-1', 'lot-1');
    await seedQualified('per-2', 'lot-2');
    const a = await createTerm('per-1', 'lot-1', '2026-01-01', '2027-01-01');
    const termA = ((await a.json()) as { id: string }).id;
    const b = await createTerm('per-2', 'lot-2', '2026-01-01', '2027-01-01');
    const termB = ((await b.json()) as { id: string }).id;

    expect(
      (
        await POST(
          req({ action: 'assignOffice', termId: termA, office: 'president' }),
        )
      ).status,
    ).toBe(201);
    const officeTaken = await POST(
      req({ action: 'assignOffice', termId: termB, office: 'president' }),
    );
    expect(officeTaken.status).toBe(409);
    expect(await officeTaken.text()).toBe(
      'That office already has a current holder',
    );
    const personBusy = await POST(
      req({ action: 'assignOffice', termId: termA, office: 'vice_president' }),
    );
    expect(personBusy.status).toBe(409);
    expect(await personBusy.text()).toBe('This person already holds an office');

    const outside = await POST(
      req({
        action: 'assignOffice',
        termId: termB,
        office: 'vice_president',
        startDay: '2028-01-01',
      }),
    );
    expect(outside.status).toBe(400);
    expect(await outside.text()).toBe('Office must start within the term');
  });

  it('endOffice and voidOffice conclude an assignment their own ways', async () => {
    await seedQualified('per-1', 'lot-1');
    const created = await createTerm(
      'per-1',
      'lot-1',
      '2026-01-01',
      '2027-01-01',
    );
    const termId = ((await created.json()) as { id: string }).id;
    const assigned = await POST(
      req({
        action: 'assignOffice',
        termId,
        office: 'president',
        startDay: '2026-01-02',
      }),
    );
    const assignmentId = ((await assigned.json()) as { id: string }).id;

    const ended = await POST(
      req({ action: 'endOffice', assignmentId, endDay: '2026-06-01' }),
    );
    expect(ended.status).toBe(204);
    const again = await POST(req({ action: 'endOffice', assignmentId }));
    expect(again.status).toBe(409);

    const voided = await POST(req({ action: 'voidOffice', assignmentId }));
    expect(voided.status).toBe(204);
    const db = getDb(env);
    const [office] = await db.select().from(boardOfficeAssignments);
    expect(office.voidedAt).not.toBeNull();
    expect(office.endDay).toBeNull();
    await integrityClean();
  });
});

describe('GET advisories', () => {
  it('derives composition warnings live', async () => {
    await seedQualified('per-1', 'lot-1');
    await seedQualified('per-2', 'lot-2');
    const a = await createTerm('per-1', 'lot-1', '2026-01-01', '2027-01-01');
    const termA = ((await a.json()) as { id: string }).id;
    await createTerm('per-2', 'lot-2', '2026-01-01', '2027-01-01');
    await POST(
      req({ action: 'assignOffice', termId: termA, office: 'president' }),
    );

    const res = await GET(req(undefined, 'GET'));
    expect(res.status).toBe(200);
    const detail = (await res.json()) as BoardServiceDetail;
    expect(detail.advisories.currentMemberCount).toBe(2);
    expect(detail.advisories.belowMinimum).toBe(true);
    expect(detail.advisories.aboveMaximum).toBe(false);
    expect(detail.advisories.vacantOffices.sort()).toEqual([
      'secretary_treasurer',
      'vice_president',
    ]);
  });

  it('surfaces expiring and lapsed terms', async () => {
    await seedQualified('per-1', 'lot-1');
    await seedQualified('per-2', 'lot-2');
    // Expiring: a current term ending within thirty days of today.
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    const soonDay = soon.toISOString().slice(0, 10);
    const expiring = await createTerm('per-1', 'lot-1', '2026-01-01', soonDay);
    const expiringId = ((await expiring.json()) as { id: string }).id;
    // Lapsed: concluded by schedule with no successor recorded.
    const lapsed = await createTerm(
      'per-2',
      'lot-2',
      '2025-01-01',
      '2025-12-01',
    );
    const lapsedId = ((await lapsed.json()) as { id: string }).id;

    const res = await GET(req(undefined, 'GET'));
    const detail = (await res.json()) as BoardServiceDetail;
    expect(detail.advisories.expiringTermIds).toContain(expiringId);
    expect(detail.advisories.lapsedTermIds).toContain(lapsedId);
  });
});
