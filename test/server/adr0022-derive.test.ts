import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import { deriveAccess } from '../../src/server/authz/derive';

// ADR 0022 derived authorization (issue #210, phase 2).
//
// Every test here pins a rule the old rank ladder got wrong. The most important
// one is the very first: a board member who owns no Lot is NOT a member.

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const db = () => getDb(env);

beforeEach(async () => {
  for (const table of [
    'access_grants',
    'board_office_assignments',
    'board_service_terms',
    'person_links',
    'person_verifications',
    'representation_lots',
    'representations',
    'ownerships',
    'contact_methods',
    'organizations',
    'people',
    'parties',
  ]) {
    await db().run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db().run(sql.raw('DELETE FROM properties'));
});

async function account(id: string) {
  const now = new Date();
  await db()
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

async function person(id: string) {
  await db().run(
    sql.raw(
      `INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('${id}', 'person', 1, 1)`,
    ),
  );
  await db().run(
    sql.raw(
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
       VALUES ('${id}', 'person', '${id}', '${id}', 1)`,
    ),
  );
}

async function lot(id: string, retired = false) {
  await db().run(
    sql.raw(
      `INSERT INTO properties (id, address, address_normalized, status, vote_weight, retired_at, created_at, updated_at)
       VALUES ('${id}', '${id} Way', '${id} way', 'active', 1, ${retired ? 99 : 'NULL'}, 1, 1)`,
    ),
  );
}

async function link(accountId: string, personId: string) {
  await db().run(
    sql.raw(
      `INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
       VALUES ('v-${accountId}', '${accountId}', '${personId}', 'manual', '${accountId}', 'manual_board_decision', 1)`,
    ),
  );
  await db().run(
    sql.raw(
      `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
       VALUES ('l-${accountId}', '${accountId}', '${personId}', 'v-${accountId}', 1)`,
    ),
  );
}

async function ownership(
  id: string,
  partyId: string,
  lotId: string,
  endDay?: string,
) {
  await db().run(
    sql.raw(
      `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, end_day, created_at, updated_at)
       VALUES ('${id}', '${partyId}', '${lotId}', '2020-01-01', ${endDay ? `'${endDay}'` : 'NULL'}, 1, 1)`,
    ),
  );
}

async function term(
  id: string,
  personId: string,
  lotId: string | null,
  startDay: string,
  scheduledEndDay: string,
) {
  await db().run(
    sql.raw(
      `INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, start_day, scheduled_end_day, created_at, updated_at)
       VALUES ('${id}', '${personId}', ${lotId ? `'${lotId}'` : 'NULL'}, '${startDay}', '${scheduledEndDay}', 1, 1)`,
    ),
  );
}

async function grant(
  id: string,
  accountId: string,
  type: string,
  termId?: string,
) {
  await db().run(
    sql.raw(
      `INSERT INTO access_grants (id, account_id, grant_type, qualifying_board_term_id, started_at)
       VALUES ('${id}', '${accountId}', '${type}', ${termId ? `'${termId}'` : 'NULL'}, 1)`,
    ),
  );
}

describe('the rank ladder is gone', () => {
  it('gives a board member who owns no Lot board access and NO member capability', async () => {
    // The named behavior change. Under `board >= homeowner` this caller passes
    // the member-only gate for free, with no association basis whatsoever.
    await account('a1');
    await person('p1');
    await link('a1', 'p1');
    await term('t1', 'p1', null, '2026-01-01', '2027-01-01');
    await grant('g1', 'a1', 'board', 't1');

    const access = await deriveAccess(env, 'a1', DAY);
    expect(access.capabilities.has('board')).toBe(true);
    expect(access.capabilities.has('member')).toBe(false);
    expect(access.lotIds).toEqual([]);
    expect(access.contentTier).toBe('board');
  });

  it('gives a system administrator who owns nothing no member capability either', async () => {
    await account('a2');
    await person('p2');
    await link('a2', 'p2');
    await grant('g2', 'a2', 'system_admin');

    const access = await deriveAccess(env, 'a2', DAY);
    expect(access.capabilities.has('systemAdmin')).toBe(true);
    // Implied, not a duplicate grant.
    expect(access.capabilities.has('board')).toBe(true);
    expect(access.capabilities.has('member')).toBe(false);
  });
});

describe('member access follows Ownership', () => {
  it('derives member capability and lots from a Current Ownership', async () => {
    await account('a3');
    await person('p3');
    await link('a3', 'p3');
    await lot('lot-1');
    await ownership('o1', 'p3', 'lot-1');

    const access = await deriveAccess(env, 'a3', DAY);
    expect(access.capabilities.has('member')).toBe(true);
    expect(access.lotIds).toEqual(['lot-1']);
    expect(access.contentTier).toBe('homeowner');
  });

  it('drops a Lot whose ownership has ended', async () => {
    await account('a4');
    await person('p4');
    await link('a4', 'p4');
    await lot('lot-2');
    await ownership('o2', 'p4', 'lot-2', '2026-01-01');

    const access = await deriveAccess(env, 'a4', DAY);
    expect(access.lotIds).toEqual([]);
    expect(access.capabilities.has('member')).toBe(false);
  });

  it('excludes a retired Lot', async () => {
    await account('a5');
    await person('p5');
    await link('a5', 'p5');
    await lot('lot-3', true);
    await ownership('o3', 'p5', 'lot-3');

    const access = await deriveAccess(env, 'a5', DAY);
    expect(access.lotIds).toEqual([]);
  });

  it('follows a consolidated duplicate to the survivor', async () => {
    await account('a6');
    await person('dupe');
    await person('survivor');
    await db().run(
      sql`UPDATE parties SET consolidated_into_party_id = 'survivor' WHERE id = 'dupe'`,
    );
    await link('a6', 'dupe');
    await lot('lot-4');
    await ownership('o4', 'survivor', 'lot-4');

    const access = await deriveAccess(env, 'a6', DAY);
    expect(access.lotIds).toEqual(['lot-4']);
  });
});

describe('representation scope', () => {
  async function organizationOwning(lotIds: string[]) {
    await db().run(
      sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('org', 'organization', 1, 1)`,
    );
    await db().run(
      sql`INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
          VALUES ('org', 'organization', 'Acme LLC', 'acme llc', 1)`,
    );
    for (const id of lotIds) {
      await lot(id);
      await ownership(`o-${id}`, 'org', id);
    }
  }

  it('organization-wide scope covers every Lot the entity owns', async () => {
    await account('a7');
    await person('rep');
    await link('a7', 'rep');
    await organizationOwning(['lot-a', 'lot-b']);
    await db().run(
      sql`INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
          VALUES ('r1', 'rep', 'org', 'organization', '2025-01-01', 1, 1)`,
    );

    const access = await deriveAccess(env, 'a7', DAY);
    expect(access.lotIds.sort()).toEqual(['lot-a', 'lot-b']);
    expect(access.capabilities.has('member')).toBe(true);
  });

  it('Lot-scoped representation covers only its named Lots', async () => {
    // The defining difference between the scopes: a scoped Representative must
    // not silently acquire a Lot the entity buys later.
    await account('a8');
    await person('rep2');
    await link('a8', 'rep2');
    await organizationOwning(['lot-c', 'lot-d']);
    await db().run(
      sql`INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
          VALUES ('r2', 'rep2', 'org', 'lots', '2025-01-01', 1, 1)`,
    );
    await db().run(
      sql`INSERT INTO representation_lots (representation_id, lot_id, created_at) VALUES ('r2', 'lot-c', 1)`,
    );

    const access = await deriveAccess(env, 'a8', DAY);
    expect(access.lotIds).toEqual(['lot-c']);
  });

  it('grants nothing for a scoped Lot the organization has since sold', async () => {
    await account('a9');
    await person('rep3');
    await link('a9', 'rep3');
    await organizationOwning(['lot-e']);
    await db().run(
      sql`UPDATE ownerships SET end_day = '2026-01-01' WHERE id = 'o-lot-e'`,
    );
    await db().run(
      sql`INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
          VALUES ('r3', 'rep3', 'org', 'lots', '2025-01-01', 1, 1)`,
    );
    await db().run(
      sql`INSERT INTO representation_lots (representation_id, lot_id, created_at) VALUES ('r3', 'lot-e', 1)`,
    );

    const access = await deriveAccess(env, 'a9', DAY);
    expect(access.lotIds).toEqual([]);
  });

  it('drops authority when the representation has ended', async () => {
    await account('a10');
    await person('rep4');
    await link('a10', 'rep4');
    await organizationOwning(['lot-f']);
    await db().run(
      sql`INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, end_day, created_at, updated_at)
          VALUES ('r4', 'rep4', 'org', 'organization', '2025-01-01', '2026-01-01', 1, 1)`,
    );

    const access = await deriveAccess(env, 'a10', DAY);
    expect(access.lotIds).toEqual([]);
  });
});

describe('grants are re-validated at evaluation', () => {
  it('ignores a live board grant whose qualifying term has ended', async () => {
    // The mutation boundary should have ended this grant. Evaluation never
    // trusts that it did.
    await account('a11');
    await person('p11');
    await link('a11', 'p11');
    await term('t-past', 'p11', null, '2024-01-01', '2025-01-01');
    await grant('g-stale', 'a11', 'board', 't-past');

    const access = await deriveAccess(env, 'a11', DAY);
    expect(access.capabilities.has('board')).toBe(false);
    expect(access.contentTier).toBe('visitor');
  });

  it('ignores a live board grant whose term was voided', async () => {
    await account('a12');
    await person('p12');
    await link('a12', 'p12');
    await term('t-void', 'p12', null, '2026-01-01', '2027-01-01');
    await db().run(
      sql`UPDATE board_service_terms SET voided_at = 99 WHERE id = 't-void'`,
    );
    await grant('g-void', 'a12', 'board', 't-void');

    const access = await deriveAccess(env, 'a12', DAY);
    expect(access.capabilities.has('board')).toBe(false);
  });

  it('honours a grant on a scheduled term that has not started', async () => {
    // Onboarding: an incoming board member may read admin surfaces before
    // serving. That is exactly why the grant is separate from the term.
    await account('a13');
    await person('p13');
    await link('a13', 'p13');
    await term('t-future', 'p13', null, '2026-09-01', '2027-09-01');
    await grant('g-future', 'a13', 'board', 't-future');

    const access = await deriveAccess(env, 'a13', DAY);
    expect(access.capabilities.has('board')).toBe(true);
    // But they may not approve identity or representation facts.
    expect(access.hasCurrentBoardTerm).toBe(false);
  });

  it('separates holding a current term from holding the grant', async () => {
    await account('a14');
    await person('p14');
    await link('a14', 'p14');
    await term('t-now', 'p14', null, '2026-01-01', '2027-01-01');
    await grant('g-now', 'a14', 'board', 't-now');

    const access = await deriveAccess(env, 'a14', DAY);
    expect(access.hasCurrentBoardTerm).toBe(true);
  });

  it('drops a grant once it has been ended', async () => {
    await account('a15');
    await person('p15');
    await link('a15', 'p15');
    await grant('g-ended', 'a15', 'system_admin');
    await db().run(
      sql`UPDATE access_grants SET ended_at = 99, ended_by_account_id = 'a15', end_reason = 'revoked' WHERE id = 'g-ended'`,
    );

    const access = await deriveAccess(env, 'a15', DAY);
    expect(access.capabilities.size).toBe(0);
  });
});

describe('no current Person Link means visitor', () => {
  it('returns visitor for an account with no link, whatever the Person owns', async () => {
    await account('a16');
    await person('p16');
    await lot('lot-x');
    await ownership('o16', 'p16', 'lot-x');
    // No person_links row.

    const access = await deriveAccess(env, 'a16', DAY);
    expect(access.personId).toBeNull();
    expect(access.capabilities.size).toBe(0);
    expect(access.lotIds).toEqual([]);
    expect(access.contentTier).toBe('visitor');
  });

  it('returns visitor once the link has ended, even with a live grant', async () => {
    await account('a17');
    await person('p17');
    await link('a17', 'p17');
    await grant('g17', 'a17', 'system_admin');
    await db().run(
      sql`UPDATE person_links SET ended_at = 99, end_reason = 'self_unlink' WHERE id = 'l-a17'`,
    );

    const access = await deriveAccess(env, 'a17', DAY);
    expect(access.personId).toBeNull();
    expect(access.capabilities.size).toBe(0);
  });
});

describe('nothing is cached', () => {
  it('reflects a revoked grant on the very next call', async () => {
    await account('a18');
    await person('p18');
    await link('a18', 'p18');
    await grant('g18', 'a18', 'system_admin');

    expect(
      (await deriveAccess(env, 'a18', DAY)).capabilities.has('systemAdmin'),
    ).toBe(true);
    await db().run(
      sql`UPDATE access_grants SET ended_at = 99, ended_by_account_id = 'a18', end_reason = 'revoked' WHERE id = 'g18'`,
    );
    expect(
      (await deriveAccess(env, 'a18', DAY)).capabilities.has('systemAdmin'),
    ).toBe(false);
  });

  it('reflects a backdated ownership the moment it is recorded', async () => {
    await account('a19');
    await person('p19');
    await link('a19', 'p19');
    await lot('lot-y');

    expect((await deriveAccess(env, 'a19', DAY)).lotIds).toEqual([]);
    await ownership('o19', 'p19', 'lot-y');
    expect((await deriveAccess(env, 'a19', DAY)).lotIds).toEqual(['lot-y']);
  });
});

describe('the Association Day is an input', () => {
  it('changes the answer for a term that has not started on the given day', async () => {
    await account('a20');
    await person('p20');
    await link('a20', 'p20');
    await term('t20', 'p20', null, '2026-09-01', '2027-09-01');

    expect(
      (await deriveAccess(env, 'a20', '2026-06-15')).hasCurrentBoardTerm,
    ).toBe(false);
    expect(
      (await deriveAccess(env, 'a20', '2026-10-01')).hasCurrentBoardTerm,
    ).toBe(true);
  });
});
