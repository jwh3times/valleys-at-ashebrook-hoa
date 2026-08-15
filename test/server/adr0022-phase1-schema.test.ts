import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';

// ADR 0022 phase 1 ("expand") — see issue #209.
//
// These tests are deliberately PREVENTIVE rather than reactive. The repo
// already pins the ALTER-added FK trap after it bit three times
// (election-schema.test.ts, proxy-schema.test.ts); this file pins the opposite
// direction for the new tables, so a regression is caught before it ships
// rather than after it costs a debugging session.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// The shared `truncateAll` deliberately does not know these tables — nothing
// writes them until phase 2. Clean locally, leaves-first.
beforeEach(async () => {
  const db = getDb(env);
  for (const table of [
    'review_flags',
    'redaction_tasks',
    'audit_sensitive_field_changes',
    'audit_scalar_changes',
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
    'system_admin_bootstrap',
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
    'cutover_shadow_mismatches',
    'cutover_settings',
  ]) {
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
});

// Same shape as the helper in proxy-schema.test.ts: drizzle 0.45 wraps D1
// errors, so the SQLite reason lives one level down on `.cause.message`.
async function expectRejectsWithReason(
  promise: Promise<unknown>,
  pattern: RegExp,
) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const err = caught as Error & { cause?: unknown };
  const text = [
    err.message,
    err.cause instanceof Error ? err.cause.message : '',
  ].join('\n');
  expect(text).toMatch(pattern);
}

const PHASE_1_TABLES = [
  'parties',
  'people',
  'organizations',
  'contact_methods',
  'ownerships',
  'representations',
  'representation_lots',
  'person_verifications',
  'person_links',
  'board_service_terms',
  'board_office_assignments',
  'access_grants',
  'system_admin_bootstrap',
  'audit_events',
  'roster_changes',
  'board_service_changes',
  'identity_events',
  'access_events',
  'roster_redactions',
  'review_events',
  'audit_record_corrections',
  'roster_change_subjects',
  'board_service_change_subjects',
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'review_flags',
  'redaction_tasks',
  'cutover_settings',
  'cutover_shadow_mismatches',
];

// The four phase-1 files, named explicitly: the CREATE/ALTER discipline below
// is a property of the phase-1 "expand" step, not of every later adr0022-named
// migration — 3b's `0024` legitimately rebuilds a table (a CHECK cannot be
// altered in SQLite), which requires a bare CREATE plus an ALTER ... RENAME.
const PHASE_1_FILES = new Set([
  '0019_adr0022_roster_core.sql',
  '0020_adr0022_audit_ledger.sql',
  '0021_adr0022_cutover_operational.sql',
  '0022_adr0022_lot_retirement_columns.sql',
]);

function phase1Migrations() {
  return env.MIGRATIONS!.filter((m) => PHASE_1_FILES.has(m.name));
}

describe('ADR 0022 phase 1 migrations', () => {
  it('creates every phase 1 table', async () => {
    const db = getDb(env);
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    const present = new Set(rows.map((r) => r.name));
    for (const table of PHASE_1_TABLES) {
      expect(present.has(table), `missing table: ${table}`).toBe(true);
    }
  });

  it('ships its four migration files', () => {
    // Named explicitly rather than counted: later ADR 0022 phases add their own
    // migrations, and a count would fail on every one of them while proving
    // nothing about phase 1.
    const names = new Set(phase1Migrations().map((m) => m.name));
    for (const file of [
      '0019_adr0022_roster_core.sql',
      '0020_adr0022_audit_ledger.sql',
      '0021_adr0022_cutover_operational.sql',
      '0022_adr0022_lot_retirement_columns.sql',
    ]) {
      expect(names.has(file), `missing migration: ${file}`).toBe(true);
    }
  });

  it('makes every CREATE re-runnable with IF NOT EXISTS', () => {
    // A half-applied file must be fixable by running it forward again:
    // Cloudflare does not document per-file atomicity and there is no un-apply.
    for (const migration of phase1Migrations()) {
      for (const query of migration.queries) {
        if (!/^\s*CREATE/i.test(query)) continue;
        expect(query, `${migration.name}: ${query.slice(0, 60)}`).toMatch(
          /IF NOT EXISTS/i,
        );
      }
    }
  });

  it('isolates the two non-re-runnable ALTER statements in their own file', () => {
    // SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS. Keeping these alone
    // bounds a half-apply to two statements a human can hand-fix.
    for (const migration of phase1Migrations()) {
      const alters = migration.queries.filter((q) =>
        /^\s*ALTER TABLE/i.test(q),
      );
      if (migration.name.includes('lot_retirement')) {
        expect(alters).toHaveLength(2);
        expect(migration.queries).toHaveLength(2);
      } else {
        expect(alters, `${migration.name} should contain no ALTERs`).toEqual(
          [],
        );
      }
    }
  });

  it('gives every new foreign key an explicit ON DELETE action', () => {
    // The inverse of the legacy pins. drizzle-kit silently drops ON DELETE on
    // ALTER-added FK columns, which has bitten this codebase three times; these
    // tables are all created with their keys, so the actions are real and must
    // stay real.
    for (const migration of phase1Migrations()) {
      for (const query of migration.queries) {
        for (const line of query.split('\n')) {
          if (!/FOREIGN KEY/i.test(line)) continue;
          expect(line, `${migration.name}: ${line.trim()}`).toMatch(
            /ON DELETE (restrict|cascade|set null)/i,
          );
        }
      }
    }
  });

  it('does not create a table named board_terms, and leaves the legacy one intact', async () => {
    // The trap this naming exists to avoid: CREATE TABLE IF NOT EXISTS
    // `board_terms` would silently do nothing, and the mismatch would surface
    // much later as confusing column errors.
    for (const migration of phase1Migrations()) {
      for (const query of migration.queries) {
        expect(query).not.toMatch(/CREATE TABLE[^;]*`board_terms`/i);
      }
    }
    const db = getDb(env);
    const columns = await db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('board_terms')`,
    );
    const names = new Set(columns.map((c) => c.name));
    for (const legacy of ['title', 'term_start', 'term_end', 'person_id']) {
      expect(names.has(legacy), `legacy board_terms lost ${legacy}`).toBe(true);
    }
    // And the new shape is definitively absent from the legacy table.
    expect(names.has('qualifying_lot_id')).toBe(false);
    expect(names.has('scheduled_end_day')).toBe(false);
  });
});

describe('ADR 0022 phase 1 CHECK constraints', () => {
  // Legacy status/method/channel/role columns accept any string, because
  // drizzle's `text(..., { enum })` is a TypeScript-only refinement that emits
  // no SQL CHECK. These assert the new tables genuinely reject at the database
  // level, which is the whole point of writing them by hand.
  const db = () => getDb(env);

  it('rejects a party kind outside the enum', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('p-bad', 'corporation', 1, 1)`,
      ),
      /CHECK constraint failed: parties_kind_check/i,
    );
  });

  it('rejects a party consolidated into itself', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO parties (id, kind, consolidated_into_party_id, created_at, updated_at) VALUES ('p-self', 'person', 'p-self', 1, 1)`,
      ),
      /CHECK constraint failed: parties_no_self_consolidation/i,
    );
  });

  it('rejects a board term carrying two ending kinds at once', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO board_service_terms (id, person_id, start_day, scheduled_end_day, actual_end_day, cancelled_day, cancelled_at, created_at, updated_at)
            VALUES ('t-bad', 'x', '2026-01-01', '2027-01-01', '2026-06-01', '2025-12-01', 1, 1, 1)`,
      ),
      /CHECK constraint failed: board_service_terms_one_ending/i,
    );
  });

  it('rejects a board term cancelled after it started', async () => {
    // A withdrawal after service began is an early end, not a cancellation.
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO board_service_terms (id, person_id, start_day, scheduled_end_day, cancelled_day, cancelled_at, created_at, updated_at)
            VALUES ('t-late', 'x', '2026-01-01', '2027-01-01', '2026-06-01', 1, 1, 1)`,
      ),
      /CHECK constraint failed: board_service_terms_cancelled_before_start/i,
    );
  });

  it('rejects a board grant with no qualifying term, and a system_admin grant with one', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO access_grants (id, account_id, grant_type, started_at) VALUES ('g-1', 'a', 'board', 1)`,
      ),
      /CHECK constraint failed: access_grants_qualifying_term_shape/i,
    );
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO access_grants (id, account_id, grant_type, qualifying_board_term_id, started_at) VALUES ('g-2', 'a', 'system_admin', 't', 1)`,
      ),
      /CHECK constraint failed: access_grants_qualifying_term_shape/i,
    );
  });

  it('rejects an initiating audit event without an operation key', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, recorded_at)
            VALUES ('e-1', 'roster_change', 'ownership_ended', 'c-1', 0, 'account', 'a', 1)`,
      ),
      /CHECK constraint failed: audit_events_initiating_shape/i,
    );
  });

  it('rejects an automatic audit event with no causing event', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, automatic_cause, recorded_at)
            VALUES ('e-2', 'access', 'grant_revoked', 'c-1', 1, 'automatic', 'term_ended', 1)`,
      ),
      /CHECK constraint failed: audit_events_automatic_shape/i,
    );
  });

  it('rejects a migration-actor event with no operator account', async () => {
    // `migration` is legal only for the backfill and still names a human.
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, operation_key, recorded_at)
            VALUES ('e-3', 'roster_change', 'ownership_created', 'c-2', 0, 'migration', 'op-1', 1)`,
      ),
      /CHECK constraint failed: audit_events_actor_account_shape/i,
    );
  });

  it('rejects a roster change subject naming two typed subjects', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO roster_change_subjects (id, event_id, role, lot_id, party_id) VALUES ('s-1', 'e', 'primary', 'l', 'p')`,
      ),
      /CHECK constraint failed: roster_change_subjects_exactly_one/i,
    );
  });

  it('rejects a review flag naming two impacted actions', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO review_flags (id, category, source_event_id, status, opened_at, impacted_proxy_id, impacted_ballot_id)
            VALUES ('f-1', 'vote_reset_on_transfer', 'e', 'open', 1, 'px', 'b')`,
      ),
      /CHECK constraint failed: review_flags_impact_at_most_one/i,
    );
  });

  it('rejects a cutover setting with a value outside its key', async () => {
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO cutover_settings (key, value, updated_at) VALUES ('cutover_mode', 'on', 1)`,
      ),
      /CHECK constraint failed: cutover_settings_value_check/i,
    );
  });
});

describe('ADR 0022 phase 1 relational invariants', () => {
  const db = () => getDb(env);

  // Person Links and verifications reference real Better Auth `user` rows with
  // RESTRICT, so identity history can never lose its actor.
  async function seedAccount(id: string) {
    const now = new Date();
    await getDb(env)
      .insert(users)
      .values({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      // This file's local cleanup deliberately does not clear `user` — other
      // suites own that table — so seeding the same approver twice is normal.
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
        `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at) VALUES ('${id}', 'person', 'A Person', 'a person', 1)`,
      ),
    );
  }

  it('refuses a person row whose party is an organization', async () => {
    // The composite (party_id, party_kind) FK is what makes the discriminator
    // load-bearing rather than decorative.
    await db().run(
      sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('org-1', 'organization', 1, 1)`,
    );
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at) VALUES ('org-1', 'person', 'X', 'x', 1)`,
      ),
      /FOREIGN KEY constraint failed|CHECK constraint failed/i,
    );
  });

  it('allows a person name to be null only alongside its redaction marker', async () => {
    await db().run(
      sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('per-r', 'person', 1, 1)`,
    );
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at) VALUES ('per-r', 'person', NULL, NULL, 1)`,
      ),
      /CHECK constraint failed: people_name_redaction_paired/i,
    );
    // With the marker, the same row is legal — this is what redaction leaves
    // behind, and reads render a durable-ID fallback from it.
    await db().run(
      sql`INSERT INTO people (party_id, party_kind, full_name, name_normalized, name_redacted_at, updated_at)
          VALUES ('per-r', 'person', NULL, NULL, 99, 1)`,
    );
  });

  it('permits at most one current person link per account', async () => {
    await seedAccount('acct-1');
    await seedAccount('approver-1');
    await seedPerson('per-1');
    await seedPerson('per-2');
    await db().run(
      sql`INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
          VALUES ('v-1', 'acct-1', 'per-1', 'manual', 'approver-1', 'manual_board_decision', 1)`,
    );
    await db().run(
      sql`INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
          VALUES ('v-2', 'acct-1', 'per-2', 'manual', 'approver-1', 'manual_board_decision', 1)`,
    );
    await db().run(
      sql`INSERT INTO person_links (id, account_id, person_id, verification_id, started_at) VALUES ('l-1', 'acct-1', 'per-1', 'v-1', 1)`,
    );
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO person_links (id, account_id, person_id, verification_id, started_at) VALUES ('l-2', 'acct-1', 'per-2', 'v-2', 1)`,
      ),
      /UNIQUE constraint failed/i,
    );
  });

  it('permits at most one current person link per person', async () => {
    await seedAccount('acct-2');
    await seedAccount('acct-3');
    await seedAccount('approver-1');
    await seedPerson('per-3');
    await db().run(
      sql`INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
          VALUES ('v-3', 'acct-2', 'per-3', 'manual', 'approver-1', 'manual_board_decision', 1)`,
    );
    await db().run(
      sql`INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
          VALUES ('v-4', 'acct-3', 'per-3', 'manual', 'approver-1', 'manual_board_decision', 1)`,
    );
    await db().run(
      sql`INSERT INTO person_links (id, account_id, person_id, verification_id, started_at) VALUES ('l-3', 'acct-2', 'per-3', 'v-3', 1)`,
    );
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO person_links (id, account_id, person_id, verification_id, started_at) VALUES ('l-4', 'acct-3', 'per-3', 'v-4', 1)`,
      ),
      /UNIQUE constraint failed/i,
    );
  });

  it('permits one current office holder per office', async () => {
    await seedPerson('per-4');
    await seedPerson('per-5');
    for (const [id, person] of [
      ['t-1', 'per-4'],
      ['t-2', 'per-5'],
    ]) {
      await db().run(
        sql.raw(
          `INSERT INTO board_service_terms (id, person_id, start_day, scheduled_end_day, created_at, updated_at) VALUES ('${id}', '${person}', '2026-01-01', '2027-01-01', 1, 1)`,
        ),
      );
    }
    await db().run(
      sql`INSERT INTO board_office_assignments (id, board_term_id, person_id, office, start_day, created_at, updated_at)
          VALUES ('o-1', 't-1', 'per-4', 'president', '2026-01-01', 1, 1)`,
    );
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO board_office_assignments (id, board_term_id, person_id, office, start_day, created_at, updated_at)
            VALUES ('o-2', 't-2', 'per-5', 'president', '2026-02-01', 1, 1)`,
      ),
      /UNIQUE constraint failed/i,
    );
    // Vice President is a distinct office and is free — the bylaws create
    // three offices, and secretary/treasurer is one combined office.
    await db().run(
      sql`INSERT INTO board_office_assignments (id, board_term_id, person_id, office, start_day, created_at, updated_at)
          VALUES ('o-3', 't-2', 'per-5', 'vice_president', '2026-02-01', 1, 1)`,
    );
  });

  it('refuses an office assignment whose person does not match its term', async () => {
    await seedPerson('per-6');
    await seedPerson('per-7');
    await db().run(
      sql`INSERT INTO board_service_terms (id, person_id, start_day, scheduled_end_day, created_at, updated_at)
          VALUES ('t-3', 'per-6', '2026-01-01', '2027-01-01', 1, 1)`,
    );
    await expectRejectsWithReason(
      db().run(
        sql`INSERT INTO board_office_assignments (id, board_term_id, person_id, office, start_day, created_at, updated_at)
            VALUES ('o-4', 't-3', 'per-7', 'president', '2026-01-01', 1, 1)`,
      ),
      /FOREIGN KEY constraint failed/i,
    );
  });
});
