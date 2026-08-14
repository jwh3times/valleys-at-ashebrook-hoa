import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';

// ADR 0022 phase 2 — audit read models and integrity views (issue #210).
//
// These views are server-side query shapes, NOT authorization boundaries. Live
// access reads current domain rows and must never grant because a
// reconstruction succeeded or deny because one failed.
//
// Each test below proves a view actually DETECTS its condition. A view that
// always returns nothing passes a naive "does it query" test and is worthless;
// the point of an integrity view is that it can go red.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const NEW_TABLES = [
  'review_flags',
  'redaction_tasks',
  'board_service_change_subjects',
  'roster_change_subjects',
  'audit_record_corrections',
  'review_events',
  'roster_redactions',
  'access_events',
  'identity_events',
  'board_service_changes',
  'roster_changes',
  'audit_events',
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
  for (const table of NEW_TABLES) {
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.run(sql.raw(`DELETE FROM properties`));
});

const db = () => getDb(env);

// Audit events name their actor with a RESTRICT foreign key, so identity
// history can never lose who acted.
async function seedAccount(id: string) {
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

async function seedPerson(id: string) {
  await db().run(
    sql.raw(
      `INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('${id}', 'person', 1, 1)`,
    ),
  );
  await db().run(
    sql.raw(
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
       VALUES ('${id}', 'person', 'A Person', 'a person', 1)`,
    ),
  );
}

async function seedLot(id: string) {
  await db().run(
    sql.raw(
      `INSERT INTO properties (id, address, address_normalized, status, vote_weight, created_at, updated_at)
       VALUES ('${id}', '${id} Road', '${id} road', 'active', 1, 1, 1)`,
    ),
  );
}

async function seedTerm(id: string, personId: string, lotId: string | null) {
  await db().run(
    sql.raw(
      `INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, start_day, scheduled_end_day, created_at, updated_at)
       VALUES ('${id}', '${personId}', ${lotId === null ? 'NULL' : `'${lotId}'`}, '2026-01-01', '2027-01-01', 1, 1)`,
    ),
  );
}

describe('ADR 0022 phase 2 audit views', () => {
  it('creates all eight views', async () => {
    const rows = await db().all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'view'`,
    );
    const present = new Set(rows.map((r) => r.name));
    for (const view of [
      'audit_event_effective_v',
      'audit_event_subjects_v',
      'audit_entity_history_v',
      'audit_operation_timeline_v',
      'audit_review_queue_v',
      'audit_redaction_compliance_v',
      'audit_integrity_violations_v',
      'board_eligibility_violations_v',
    ]) {
      expect(present.has(view), `missing view: ${view}`).toBe(true);
    }
  });

  it('resolves a typed subject without a nine-way union', async () => {
    // D1 caps compound SELECTs at five terms, so the obvious one-branch-per-
    // column shape cannot be created at all. This asserts the CASE/COALESCE
    // replacement actually resolves the right kind and id.
    await seedAccount('op-acct');
    await seedLot('lot-a');
    await db().run(
      sql`INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
          VALUES ('ev-1', 'roster_change', 'ownership_ended', 'corr-1', 0, 'migration', 'op-acct', 'opkey-1', 100)`,
    );
    await db().run(
      sql`INSERT INTO roster_change_subjects (id, event_id, role, lot_id) VALUES ('sub-1', 'ev-1', 'primary', 'lot-a')`,
    );
    const rows = await db().all<{ subject_kind: string; subject_id: string }>(
      sql`SELECT subject_kind, subject_id FROM audit_event_subjects_v WHERE event_id = 'ev-1'`,
    );
    expect(rows).toEqual([{ subject_kind: 'lot', subject_id: 'lot-a' }]);
  });

  it('reports an audit event with no typed detail', async () => {
    await seedAccount('op-acct');
    await db().run(
      sql`INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
          VALUES ('ev-2', 'roster_change', 'ownership_created', 'corr-2', 0, 'migration', 'op-acct', 'opkey-2', 100)`,
    );
    const rows = await db().all<{ event_id: string; violation: string }>(
      sql`SELECT event_id, violation FROM audit_integrity_violations_v`,
    );
    expect(rows).toContainEqual({
      event_id: 'ev-2',
      violation: 'detail_cardinality',
    });
  });

  it('is quiet when a board term still has its qualifying ownership', async () => {
    await seedPerson('per-1');
    await seedLot('lot-1');
    await db().run(
      sql`INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
          VALUES ('own-1', 'per-1', 'lot-1', '2025-01-01', 1, 1)`,
    );
    await seedTerm('term-1', 'per-1', 'lot-1');
    const rows = await db().all(
      sql`SELECT * FROM board_eligibility_violations_v`,
    );
    expect(rows).toEqual([]);
  });

  it('reports a board term whose qualifying ownership has ended', async () => {
    // The case derived authorization deliberately does NOT re-check per
    // request: the mutation boundary is supposed to substitute or terminate
    // atomically, and this view is how that decision stays honest.
    await seedPerson('per-2');
    await seedLot('lot-2');
    await db().run(
      sql`INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, end_day, created_at, updated_at)
          VALUES ('own-2', 'per-2', 'lot-2', '2025-01-01', '2026-06-01', 1, 1)`,
    );
    await seedTerm('term-2', 'per-2', 'lot-2');
    const rows = await db().all<{ board_term_id: string; violation: string }>(
      sql`SELECT board_term_id, violation FROM board_eligibility_violations_v`,
    );
    expect(rows).toEqual([
      { board_term_id: 'term-2', violation: 'qualifying_basis_missing' },
    ]);
  });

  it('accepts a term qualified through an organization representation', async () => {
    await seedPerson('rep-1');
    await seedLot('lot-3');
    await db().run(
      sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('org-1', 'organization', 1, 1)`,
    );
    await db().run(
      sql`INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
          VALUES ('org-1', 'organization', 'Acme LLC', 'acme llc', 1)`,
    );
    await db().run(
      sql`INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
          VALUES ('own-3', 'org-1', 'lot-3', '2025-01-01', 1, 1)`,
    );
    // Organization-wide scope follows whatever the entity owns, now and later.
    await db().run(
      sql`INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
          VALUES ('rep-row-1', 'rep-1', 'org-1', 'organization', '2025-01-01', 1, 1)`,
    );
    await seedTerm('term-3', 'rep-1', 'lot-3');
    const rows = await db().all(
      sql`SELECT * FROM board_eligibility_violations_v`,
    );
    expect(rows).toEqual([]);
  });

  it('reports a current board term carrying no qualifying lot at all', async () => {
    // NULL is legal only for accepted legacy terms that have already ended.
    await seedPerson('per-3');
    await seedTerm('term-4', 'per-3', null);
    const rows = await db().all<{ board_term_id: string; violation: string }>(
      sql`SELECT board_term_id, violation FROM board_eligibility_violations_v`,
    );
    expect(rows).toEqual([
      {
        board_term_id: 'term-4',
        violation: 'current_term_without_qualifying_lot',
      },
    ]);
  });

  it('ignores a voided term entirely', async () => {
    await seedPerson('per-4');
    await db().run(
      sql`INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, start_day, scheduled_end_day, voided_at, created_at, updated_at)
          VALUES ('term-5', 'per-4', NULL, '2026-01-01', '2027-01-01', 99, 1, 1)`,
    );
    const rows = await db().all(
      sql`SELECT * FROM board_eligibility_violations_v`,
    );
    expect(rows).toEqual([]);
  });
});
