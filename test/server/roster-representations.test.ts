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
  representationLots,
  boardServiceTerms,
} from '../../src/server/db/roster-schema';
import { POST } from '../../src/pages/api/admin/roster-representations';

/**
 * #218's Representation surface (#202): the scope asymmetry as the definition
 * (organization-wide follows later acquisitions, Lot-scoped never grows), a
 * future end day allowed here and nowhere else on the roster, scope rows
 * voided rather than deleted, and the consequence engine riding removals.
 */

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    (await importActual<typeof import('../../src/server/authz/context')>())
      .legacyAuthContext('board-1', 'board', []),
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
  'representation_lots',
  'representations',
  'ownerships',
  'organizations',
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
  await getDb(env).insert(properties).values({
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
  await getDb(env).insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName: `Person ${id}`,
    nameNormalized: `person ${id}`,
    updatedAt: now,
  });
}

async function seedOrganization(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'organization', createdAt: now, updatedAt: now });
  await getDb(env).insert(organizations).values({
    partyId: id,
    partyKind: 'organization',
    legalName: `Org ${id}`,
    nameNormalized: `org ${id}`,
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

async function seedTerm(id: string, personId: string, qualifyingLotId: string) {
  const now = new Date();
  await getDb(env).insert(boardServiceTerms).values({
    id,
    personId,
    qualifyingLotId,
    startDay: '2026-01-01',
    scheduledEndDay: '2027-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

function req(body: unknown): never {
  return {
    request: new Request('http://localhost/api/admin/roster-representations', {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never;
}

async function integrityClean() {
  const db = getDb(env);
  expect(await db.all(sql`SELECT * FROM audit_integrity_violations_v`)).toEqual([]);
  expect(await db.all(sql`SELECT * FROM board_eligibility_violations_v`)).toEqual([]);
}

describe('create', () => {
  it('records an organization-wide representation and accepts a future end day', async () => {
    await seedPerson('per-1');
    await seedOrganization('org-1');
    const res = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'organization',
        startDay: '2026-01-01',
        endDay: '2030-01-01',
      }),
    );
    expect(res.status).toBe(201);
    await integrityClean();
  });

  it('enforces the scope XOR and org-owns-lot at acceptance', async () => {
    await seedPerson('per-1');
    await seedOrganization('org-1');
    await seedLot('lot-owned');
    await seedLot('lot-unowned');
    await seedOwnership('own-org', 'org-1', 'lot-owned');

    const withLots = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'organization',
        lotIds: ['lot-owned'],
        startDay: '2026-01-01',
      }),
    );
    expect(withLots.status).toBe(400);

    const emptyLots = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'lots',
        lotIds: [],
        startDay: '2026-01-01',
      }),
    );
    expect(emptyLots.status).toBe(400);

    const unowned = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'lots',
        lotIds: ['lot-unowned'],
        startDay: '2026-01-01',
      }),
    );
    expect(unowned.status).toBe(409);
    expect(await unowned.text()).toBe(
      'Organization does not currently own that lot',
    );

    const scoped = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'lots',
        lotIds: ['lot-owned'],
        startDay: '2026-01-01',
      }),
    );
    expect(scoped.status).toBe(201);
    const db = getDb(env);
    const scopeRows = await db.select().from(representationLots);
    expect(scopeRows).toHaveLength(1);
    expect(scopeRows[0].lotId).toBe('lot-owned');
  });

  it('refuses an anticipated start and a duplicate effective pair', async () => {
    await seedPerson('per-1');
    await seedOrganization('org-1');
    const future = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'organization',
        startDay: '2030-01-01',
      }),
    );
    expect(future.status).toBe(400);

    const first = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'organization',
        startDay: '2026-01-01',
      }),
    );
    expect(first.status).toBe(201);
    const second = await POST(
      req({
        action: 'create',
        representativePersonId: 'per-1',
        organizationPartyId: 'org-1',
        scopeKind: 'organization',
        startDay: '2026-02-01',
      }),
    );
    expect(second.status).toBe(409);
  });
});

describe('end', () => {
  it('a future end schedules the retirement and removes no authority today', async () => {
    await seedPerson('per-1');
    await seedOrganization('org-1');
    await seedLot('lot-1');
    await seedOwnership('own-org', 'org-1', 'lot-1');
    const now = new Date();
    await getDb(env).insert(representations).values({
      id: 'rep-1',
      representativePersonId: 'per-1',
      organizationPartyId: 'org-1',
      scopeKind: 'organization',
      startDay: '2025-06-01',
      createdAt: now,
      updatedAt: now,
    });
    await seedTerm('term-1', 'per-1', 'lot-1');

    const res = await POST(
      req({ action: 'end', representationId: 'rep-1', endDay: '2030-01-01' }),
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
  });

  it('an effective-today end terminates the term the representation carried', async () => {
    await seedPerson('per-1');
    await seedOrganization('org-1');
    await seedLot('lot-1');
    await seedOwnership('own-org', 'org-1', 'lot-1');
    const now = new Date();
    await getDb(env).insert(representations).values({
      id: 'rep-1',
      representativePersonId: 'per-1',
      organizationPartyId: 'org-1',
      scopeKind: 'organization',
      startDay: '2025-06-01',
      createdAt: now,
      updatedAt: now,
    });
    await seedTerm('term-1', 'per-1', 'lot-1');

    const res = await POST(
      req({ action: 'end', representationId: 'rep-1', endDay: TODAY }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.actualEndDay).toBe(TODAY);
    await integrityClean();
  });
});

describe('correctScope', () => {
  it('voids removed scope rows (never deletes) and terminates the term they carried', async () => {
    await seedPerson('per-1');
    await seedOrganization('org-1');
    await seedLot('lot-1');
    await seedLot('lot-2');
    await seedOwnership('own-1', 'org-1', 'lot-1');
    await seedOwnership('own-2', 'org-1', 'lot-2');
    const now = new Date();
    await getDb(env).insert(representations).values({
      id: 'rep-1',
      representativePersonId: 'per-1',
      organizationPartyId: 'org-1',
      scopeKind: 'lots',
      startDay: '2025-06-01',
      createdAt: now,
      updatedAt: now,
    });
    await getDb(env)
      .insert(representationLots)
      .values([
        { representationId: 'rep-1', lotId: 'lot-1', createdAt: now },
        { representationId: 'rep-1', lotId: 'lot-2', createdAt: now },
      ]);
    await seedTerm('term-1', 'per-1', 'lot-2');

    const res = await POST(
      req({
        action: 'correctScope',
        representationId: 'rep-1',
        scopeKind: 'lots',
        lotIds: ['lot-1'],
      }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const scopeRows = await db.select().from(representationLots);
    expect(scopeRows).toHaveLength(2);
    const removed = scopeRows.find((r) => r.lotId === 'lot-2');
    expect(removed?.voidedAt).not.toBeNull();
    const kept = scopeRows.find((r) => r.lotId === 'lot-1');
    expect(kept?.voidedAt).toBeNull();

    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.actualEndDay).toBe(TODAY);
    await integrityClean();
  });
});

describe('void', () => {
  it('voids the representation and terminates what it alone carried', async () => {
    await seedPerson('per-1');
    await seedOrganization('org-1');
    await seedLot('lot-1');
    await seedOwnership('own-org', 'org-1', 'lot-1');
    const now = new Date();
    await getDb(env).insert(representations).values({
      id: 'rep-1',
      representativePersonId: 'per-1',
      organizationPartyId: 'org-1',
      scopeKind: 'organization',
      startDay: '2025-06-01',
      createdAt: now,
      updatedAt: now,
    });
    await seedTerm('term-1', 'per-1', 'lot-1');

    const res = await POST(req({ action: 'void', representationId: 'rep-1' }));
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [rep] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, 'rep-1'));
    expect(rep.voidedAt).not.toBeNull();
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, 'term-1'));
    expect(term.actualEndDay).toBe(TODAY);
    await integrityClean();
  });
});
