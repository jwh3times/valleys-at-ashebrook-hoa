import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { properties } from '../../src/server/db/schema';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  organizations,
  ownerships,
  representations,
  boardServiceTerms,
  boardOfficeAssignments,
  accessGrants,
} from '../../src/server/db/roster-schema';
import { POST } from '../../src/pages/api/admin/roster-ownerships';

/**
 * #218's Ownership surface, and through it the substitute-or-terminate
 * consequence engine (#202/#203): the sharpest rules in phase 3b — the
 * backdated split between the term's real-world end day and the grant's
 * recorded-at end, terminate-by-default with validated in-command
 * substitution, and the whole command failing when a named substitute does
 * not qualify.
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
const PAST = '2026-01-10';

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
  'representation_lots',
  'representations',
  'ownerships',
  'contact_methods',
  'organizations',
  'people',
  'parties',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    if (table === 'audit_events') {
      // Self-referential causing_event_id is RESTRICT: consequences first,
      // roots second, or the single-statement delete trips its own FK.
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

async function seedPerson(id: string, fullName = `Person ${id}`) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env).insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName,
    nameNormalized: fullName.toLowerCase(),
    updatedAt: now,
  });
}

async function seedOrganization(id: string, legalName = `Org ${id}`) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'organization', createdAt: now, updatedAt: now });
  await getDb(env).insert(organizations).values({
    partyId: id,
    partyKind: 'organization',
    legalName,
    nameNormalized: legalName.toLowerCase(),
    updatedAt: now,
  });
}

async function seedOwnership(
  id: string,
  ownerPartyId: string,
  lotId: string,
  overrides: Partial<{ startDay: string | null; endDay: string | null }> = {},
) {
  const now = new Date();
  await getDb(env)
    .insert(ownerships)
    .values({
      id,
      ownerPartyId,
      lotId,
      startDay:
        overrides.startDay === undefined ? '2025-01-01' : overrides.startDay,
      endDay: overrides.endDay ?? null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedTerm(
  id: string,
  personId: string,
  qualifyingLotId: string,
  overrides: Partial<{ startDay: string; scheduledEndDay: string }> = {},
) {
  const now = new Date();
  await getDb(env)
    .insert(boardServiceTerms)
    .values({
      id,
      personId,
      qualifyingLotId,
      startDay: overrides.startDay ?? '2026-01-01',
      scheduledEndDay: overrides.scheduledEndDay ?? '2027-01-01',
      createdAt: now,
      updatedAt: now,
    });
}

async function seedOffice(id: string, termId: string, personId: string) {
  const now = new Date();
  await getDb(env).insert(boardOfficeAssignments).values({
    id,
    boardTermId: termId,
    personId,
    office: 'president',
    startDay: '2026-01-02',
    createdAt: now,
    updatedAt: now,
  });
}

async function seedGrant(id: string, accountId: string, termId: string) {
  await getDb(env)
    .insert(accessGrants)
    .values({
      id,
      accountId,
      grantType: 'board',
      qualifyingBoardTermId: termId,
      startedAt: new Date('2026-01-02T00:00:00Z'),
      grantReason: 'board_service',
    });
}

function req(body: unknown): never {
  return {
    request: new Request('http://localhost/api/admin/roster-ownerships', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as never;
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

describe('create', () => {
  it('records an ownership with its ledger root', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    const res = await POST(
      req({
        action: 'create',
        ownerPartyId: 'per-1',
        lotId: 'lot-1',
        startDay: PAST,
      }),
    );
    expect(res.status).toBe(201);
    const db = getDb(env);
    const [root] = await db.all<{
      event_kind: string;
      correlation_sequence: number;
      operation_key: string | null;
    }>(
      sql`SELECT event_kind, correlation_sequence, operation_key FROM audit_events`,
    );
    expect(root.event_kind).toBe('ownership_recorded');
    expect(root.correlation_sequence).toBe(0);
    expect(root.operation_key).not.toBeNull();
    await integrityClean();
  });

  it('refuses an anticipated start, a retired lot, and a consolidated party', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    const future = await POST(
      req({
        action: 'create',
        ownerPartyId: 'per-1',
        lotId: 'lot-1',
        startDay: '2030-01-01',
      }),
    );
    expect(future.status).toBe(400);

    await getDb(env).run(
      sql`UPDATE properties SET retired_at = ${Date.now()} WHERE id = ${'lot-1'}`,
    );
    const retired = await POST(
      req({
        action: 'create',
        ownerPartyId: 'per-1',
        lotId: 'lot-1',
        startDay: PAST,
      }),
    );
    expect(retired.status).toBe(409);
    expect(await retired.text()).toBe('Lot is retired');

    await seedLot('lot-2');
    await seedPerson('per-2');
    await getDb(env).run(
      sql`UPDATE parties SET consolidated_into_party_id = ${'per-2'} WHERE id = ${'per-1'}`,
    );
    const consolidated = await POST(
      req({
        action: 'create',
        ownerPartyId: 'per-1',
        lotId: 'lot-2',
        startDay: PAST,
      }),
    );
    expect(consolidated.status).toBe(409);
  });

  it('refuses a duplicate current ownership and a historical overlap, allowing adjacency', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-old', 'per-1', 'lot-1', {
      startDay: '2024-01-01',
      endDay: '2025-06-01',
    });

    const overlapping = await POST(
      req({
        action: 'create',
        ownerPartyId: 'per-1',
        lotId: 'lot-1',
        startDay: '2025-01-01',
      }),
    );
    expect(overlapping.status).toBe(409);

    const adjacent = await POST(
      req({
        action: 'create',
        ownerPartyId: 'per-1',
        lotId: 'lot-1',
        startDay: '2025-06-01',
      }),
    );
    expect(adjacent.status).toBe(201);

    const duplicate = await POST(
      req({
        action: 'create',
        ownerPartyId: 'per-1',
        lotId: 'lot-1',
        startDay: '2025-07-01',
      }),
    );
    expect(duplicate.status).toBe(409);
  });
});

describe('end, and the consequence engine', () => {
  it('splits the backdated day: term ends then, grant ends now, office ends too', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await seedTerm('term-1', 'per-1', 'lot-1');
    await seedOffice('office-1', 'term-1', 'per-1');
    await seedGrant('grant-1', 'board-1', 'term-1');

    const before = Date.now();
    const res = await POST(
      req({ action: 'end', ownershipId: 'own-1', endDay: '2026-07-01' }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.actualEndDay).toBe('2026-07-01');
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'grant-1'));
    expect(grant.endedAt).not.toBeNull();
    expect(grant.endedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(grant.endReason).toBe('term_ended');
    const [office] = await db
      .select()
      .from(boardOfficeAssignments)
      .where(eq(boardOfficeAssignments.id, 'office-1'));
    expect(office.endDay).toBe('2026-07-01');
    expect(office.voidedAt).toBeNull();

    // One correlation: the root plus automatic consequences naming it.
    const events = await db.all<{
      event_kind: string;
      correlation_sequence: number;
      actor_kind: string;
      causing_event_id: string | null;
      correlation_id: string;
    }>(
      sql`SELECT event_kind, correlation_sequence, actor_kind, causing_event_id, correlation_id FROM audit_events ORDER BY correlation_sequence`,
    );
    const root = events.find((e) => e.correlation_sequence === 0)!;
    expect(root.event_kind).toBe('ownership_ended');
    expect(root.actor_kind).toBe('account');
    const kinds = events.map((e) => e.event_kind);
    expect(kinds).toContain('board_term_ended');
    expect(kinds).toContain('office_assignment_ended');
    expect(kinds).toContain('grant_ended');
    for (const e of events) {
      expect(e.correlation_id).toBe(root.correlation_id);
      if (e.correlation_sequence > 0) {
        expect(e.actor_kind).toBe('automatic');
        expect(e.causing_event_id).not.toBeNull();
      }
    }
    await integrityClean();
  });

  it('substitutes a validated lot instead of terminating, with three typed subjects', async () => {
    await seedLot('lot-1');
    await seedLot('lot-2');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await seedOwnership('own-2', 'per-1', 'lot-2');
    await seedTerm('term-1', 'per-1', 'lot-1');

    const res = await POST(
      req({
        action: 'end',
        ownershipId: 'own-1',
        endDay: TODAY,
        substitutions: [{ termId: 'term-1', qualifyingLotId: 'lot-2' }],
      }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.qualifyingLotId).toBe('lot-2');
    expect(term.actualEndDay).toBeNull();

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
    expect(subjects.find((s) => s.role === 'primary')?.board_term_id).toBe(
      'term-1',
    );
    expect(subjects.find((s) => s.role === 'related')?.lot_id).toBe('lot-1');
    expect(subjects.find((s) => s.role === 'replacement')?.lot_id).toBe(
      'lot-2',
    );
    await integrityClean();
  });

  it('fails the whole command when a named substitute does not qualify', async () => {
    await seedLot('lot-1');
    await seedLot('lot-x');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await seedTerm('term-1', 'per-1', 'lot-1');

    const res = await POST(
      req({
        action: 'end',
        ownershipId: 'own-1',
        endDay: TODAY,
        substitutions: [{ termId: 'term-1', qualifyingLotId: 'lot-x' }],
      }),
    );
    expect(res.status).toBe(409);

    const db = getDb(env);
    const [own] = await db
      .select()
      .from(ownerships)
      .where(eq(ownerships.id, 'own-1'));
    expect(own.endDay).toBeNull();
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.qualifyingLotId).toBe('lot-1');
    expect(term.actualEndDay).toBeNull();
    expect(await db.all(sql`SELECT * FROM audit_events`)).toEqual([]);
  });

  it('cancels a scheduled term rather than ending it', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await seedTerm('term-sched', 'per-1', 'lot-1', {
      startDay: '2030-01-01',
      scheduledEndDay: '2031-01-01',
    });

    const res = await POST(
      req({ action: 'end', ownershipId: 'own-1', endDay: TODAY }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-sched'));
    expect(term.cancelledAt).not.toBeNull();
    expect(term.actualEndDay).toBeNull();
    expect(term.cancelledDay! < '2030-01-01').toBe(true);
    const kinds = await db.all<{ event_kind: string }>(
      sql`SELECT event_kind FROM audit_events`,
    );
    expect(kinds.map((k) => k.event_kind)).toContain('board_term_cancelled');
    await integrityClean();
  });

  it('keeps a term whose person still qualifies through another basis', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOrganization('org-1');
    await seedOwnership('own-personal', 'per-1', 'lot-1');
    await seedOwnership('own-org', 'org-1', 'lot-1');
    const now = new Date();
    await getDb(env).insert(representations).values({
      id: 'rep-1',
      representativePersonId: 'per-1',
      organizationPartyId: 'org-1',
      scopeKind: 'organization',
      startDay: '2025-01-01',
      createdAt: now,
      updatedAt: now,
    });
    await seedTerm('term-1', 'per-1', 'lot-1');

    // Ending the personal ownership leaves the representation-through-org
    // basis intact, so the term survives untouched.
    const res = await POST(
      req({ action: 'end', ownershipId: 'own-personal', endDay: TODAY }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.actualEndDay).toBeNull();
    expect(term.cancelledAt).toBeNull();
    await integrityClean();

    // Ending the ORG's ownership then removes the last basis; the surviving
    // representation grants nothing (#202) and the term terminates.
    const res2 = await POST(
      req({ action: 'end', ownershipId: 'own-org', endDay: TODAY }),
    );
    expect(res2.status).toBe(204);
    const [after] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(after.actualEndDay).toBe(TODAY);
    const [rep] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, 'rep-1'));
    expect(rep.endDay).toBeNull();
    await integrityClean();
  });

  it('refuses a future endDay', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    const res = await POST(
      req({ action: 'end', ownershipId: 'own-1', endDay: '2030-01-01' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('void', () => {
  it('voids with consequences at today, leaving the ledger causally intact', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await seedTerm('term-1', 'per-1', 'lot-1');

    const res = await POST(req({ action: 'void', ownershipId: 'own-1' }));
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [own] = await db
      .select()
      .from(ownerships)
      .where(eq(ownerships.id, 'own-1'));
    expect(own.voidedAt).not.toBeNull();
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.actualEndDay).toBe(TODAY);
    await integrityClean();
  });
});
