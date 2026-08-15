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
  personVerifications,
  personLinks,
} from '../../src/server/db/roster-schema';
import { GET as rosterGet } from '../../src/pages/api/admin/roster';
import { POST } from '../../src/pages/api/admin/roster-parties';
import type { AdminRoster } from '../../src/server/roster/reads';

/**
 * #218's Party surface (#202, #205): atomic party+subtype creation, the
 * deliberate non-uniqueness of organization names (warn, never merge),
 * explicit-survivor consolidation with its refusals, and the guarantee that
 * no personal value ever lands in a ledger column. The admin roster GET's
 * assertions live here too — it is the read these writes feed.
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

const CLEAR = [
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'roster_change_subjects',
  'roster_changes',
  'access_events',
  'audit_events',
  'person_links',
  'person_verifications',
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

function req(body?: unknown, method = 'POST'): never {
  return {
    request: new Request('http://localhost/api/admin/roster-parties', {
      method,
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

async function subtypeComplete() {
  const orphans = await getDb(env).all(
    sql`SELECT p.id FROM parties p
        LEFT JOIN people pe ON pe.party_id = p.id
        LEFT JOIN organizations o ON o.party_id = p.id
        WHERE pe.party_id IS NULL AND o.party_id IS NULL`,
  );
  expect(orphans).toEqual([]);
}

describe('creation', () => {
  it('creates a person atomically with its subtype row and a category-only ledger trace', async () => {
    const res = await POST(
      req({ action: 'createPerson', fullName: 'Avery UNIQUE-NAME-XYZ' }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    await subtypeComplete();

    const db = getDb(env);
    const [person] = await db
      .select()
      .from(people)
      .where(eq(people.partyId, id));
    expect(person.fullName).toBe('Avery UNIQUE-NAME-XYZ');

    // The value appears in NO ledger column; the CATEGORY does.
    for (const [table, column] of [
      ['audit_scalar_changes', 'old_text'],
      ['audit_scalar_changes', 'new_text'],
      ['roster_changes', 'external_reference'],
      ['audit_events', 'event_kind'],
    ] as const) {
      const hits = await db.all<{ n: number }>(
        sql.raw(
          `SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" LIKE '%UNIQUE-NAME-XYZ%'`,
        ),
      );
      expect(hits[0].n, `${table}.${column}`).toBe(0);
    }
    const sensitive = await db.all<{ field_category: string }>(
      sql`SELECT field_category FROM audit_sensitive_field_changes`,
    );
    expect(sensitive.map((s) => s.field_category)).toContain('person_name');
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('warns on an organization name collision but still creates', async () => {
    const first = await POST(
      req({ action: 'createOrganization', legalName: 'The Smith Family Trust' }),
    );
    expect(first.status).toBe(201);
    expect((await first.json()) as object).not.toHaveProperty('warning');

    const second = await POST(
      req({ action: 'createOrganization', legalName: 'The Smith Family Trust' }),
    );
    expect(second.status).toBe(201);
    const body = (await second.json()) as { id: string; warning?: string };
    expect(body.warning).toContain('already exists');
    await subtypeComplete();

    const db = getDb(env);
    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(2);
  });
});

describe('name corrections', () => {
  it('corrects a person name and refuses a redacted one', async () => {
    const created = await POST(
      req({ action: 'createPerson', fullName: 'Old Name' }),
    );
    const id = ((await created.json()) as { id: string }).id;

    const res = await POST(
      req({ action: 'correctPersonName', personId: id, fullName: 'New Name' }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [person] = await db
      .select()
      .from(people)
      .where(eq(people.partyId, id));
    expect(person.fullName).toBe('New Name');

    await db.run(
      sql`UPDATE people SET full_name = NULL, name_normalized = NULL, name_redacted_at = ${Date.now()} WHERE party_id = ${id}`,
    );
    const redacted = await POST(
      req({ action: 'correctPersonName', personId: id, fullName: 'X' }),
    );
    expect(redacted.status).toBe(409);
  });
});

describe('consolidation', () => {
  async function createPerson(fullName: string): Promise<string> {
    const res = await POST(req({ action: 'createPerson', fullName }));
    return ((await res.json()) as { id: string }).id;
  }

  async function link(accountId: string, personId: string) {
    const db = getDb(env);
    const now = new Date();
    await db.insert(users).values({
      id: accountId,
      name: accountId,
      email: `${accountId}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(personVerifications).values({
      id: `ver-${accountId}`,
      accountId,
      personId,
      method: 'manual',
      approverAccountId: 'board-1',
      reason: 'manual_board_decision',
      verifiedAt: now,
    });
    await db.insert(personLinks).values({
      id: `link-${accountId}`,
      accountId,
      personId,
      verificationId: `ver-${accountId}`,
      startedAt: now,
    });
  }

  it('consolidates with duplicate and survivor subjects, one hop, same kind', async () => {
    const dup = await createPerson('Jay Duplicate');
    const survivor = await createPerson('Jay Survivor');
    const org = await POST(
      req({ action: 'createOrganization', legalName: 'Jay LLC' }),
    );
    const orgId = ((await org.json()) as { id: string }).id;

    const crossKind = await POST(
      req({ action: 'consolidate', duplicatePartyId: dup, survivorPartyId: orgId }),
    );
    expect(crossKind.status).toBe(409);
    expect(await crossKind.text()).toBe('Parties are different kinds');

    const res = await POST(
      req({ action: 'consolidate', duplicatePartyId: dup, survivorPartyId: survivor }),
    );
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [dupRow] = await db
      .select()
      .from(parties)
      .where(eq(parties.id, dup));
    expect(dupRow.consolidatedIntoPartyId).toBe(survivor);

    const subjects = await db.all<{ role: string }>(
      sql`SELECT s.role FROM roster_change_subjects s
          JOIN audit_events e ON e.id = s.event_id
          WHERE e.event_kind = 'parties_consolidated'`,
    );
    expect(subjects.map((s) => s.role).sort()).toEqual(['duplicate', 'survivor']);

    // One-hop: the freshly consolidated duplicate cannot be a survivor.
    const third = await createPerson('Jay Third');
    const chained = await POST(
      req({ action: 'consolidate', duplicatePartyId: third, survivorPartyId: dup }),
    );
    expect(chained.status).toBe(409);

    // Correction clears the pointer; there is no unconsolidate.
    const corrected = await POST(
      req({ action: 'correctConsolidation', duplicatePartyId: dup }),
    );
    expect(corrected.status).toBe(204);
    const [cleared] = await db
      .select()
      .from(parties)
      .where(eq(parties.id, dup));
    expect(cleared.consolidatedIntoPartyId).toBeNull();
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('refuses while both persons hold current account links', async () => {
    const a = await createPerson('Linked A');
    const b = await createPerson('Linked B');
    await link('acct-a', a);
    await link('acct-b', b);
    const res = await POST(
      req({ action: 'consolidate', duplicatePartyId: a, survivorPartyId: b }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('System Administrator');
  });
});

describe('GET /api/admin/roster', () => {
  it('assembles the surface with the ownerless advisory and redaction fallbacks', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(properties).values({
      id: 'lot-1',
      address: '1 Ashebrook Lane',
      addressNormalized: '1 ashebrook lane',
      status: 'active',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
    const created = await POST(
      req({ action: 'createPerson', fullName: 'Shown Then Redacted' }),
    );
    const personId = ((await created.json()) as { id: string }).id;
    await db.run(
      sql`UPDATE people SET full_name = NULL, name_normalized = NULL, name_redacted_at = ${Date.now()} WHERE party_id = ${personId}`,
    );

    const res = await rosterGet(req(undefined, 'GET'));
    expect(res.status).toBe(200);
    const roster = (await res.json()) as AdminRoster;
    expect(roster.advisories.ownerlessLotIds).toEqual(['lot-1']);
    const person = roster.people.find((p) => p.partyId === personId);
    expect(person?.nameRedacted).toBe(true);
    expect(person?.displayName).toBe(`Resident ${personId.slice(0, 8)}`);
    expect(person?.displayName).not.toContain('Redacted');
  });
});
