import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';

// Migration 0043 (#294 slice 2): creates `tenancies` and rebuilds
// `roster_change_subjects` to add a `tenancy_id` subject. The rebuild must
// carry every existing subject row across unchanged, and the two views it
// drops and recreates must read both old and new rows.

beforeAll(async () => {
  await applyD1Migrations(
    env.DATABASE,
    env.MIGRATIONS!.filter((m) => Number.parseInt(m.name, 10) < 43),
  );
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES ('op', 'op', 'op@example.test', 0, 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO lots (id, address, address_normalized, status, created_at, updated_at)
       VALUES ('lot-a', '1 Example Way', '1 example way', 'active', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
       VALUES ('ev-old', 'roster_change', 'lot_retired', 'corr-old', 0, 'migration', 'op', 'opkey-old', 100)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO roster_change_subjects (id, event_id, role, lot_id)
       VALUES ('sub-old', 'ev-old', 'primary', 'lot-a')`,
    ),
  ]);
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

it('carries every existing subject row across, with no Tenancy', async () => {
  expect(
    await env.DATABASE.prepare(
      `SELECT id, event_id, role, lot_id, tenancy_id FROM roster_change_subjects`,
    ).all(),
  ).toMatchObject({
    results: [
      {
        id: 'sub-old',
        event_id: 'ev-old',
        role: 'primary',
        lot_id: 'lot-a',
        tenancy_id: null,
      },
    ],
  });
  expect(
    (await env.DATABASE.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});

it('records a Tenancy as a subject, which both recreated views resolve', async () => {
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('owner', 'person', 1, 1), ('tenant', 'person', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
       VALUES ('owner', 'person', 'Olive Owner', 'olive owner', 1), ('tenant', 'person', 'Tess Tenant', 'tess tenant', 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
       VALUES ('own', 'owner', 'lot-a', '2025-01-01', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id, start_day, scheduled_end_day, created_at, updated_at)
       VALUES ('ten', 'tenant', 'lot-a', 'own', '2026-01-01', '2027-01-01', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
       VALUES ('ev-new', 'roster_change', 'tenancy_ended', 'corr-new', 0, 'migration', 'op', 'opkey-new', 200)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO roster_change_subjects (id, event_id, role, tenancy_id)
       VALUES ('sub-new', 'ev-new', 'ended', 'ten')`,
    ),
  ]);
  expect(
    (
      await env.DATABASE.prepare(
        `SELECT event_id, subject_kind, subject_id FROM audit_event_subjects_v ORDER BY event_id`,
      ).all()
    ).results,
  ).toEqual([
    { event_id: 'ev-new', subject_kind: 'tenancy', subject_id: 'ten' },
    { event_id: 'ev-old', subject_kind: 'lot', subject_id: 'lot-a' },
  ]);
  expect(
    await env.DATABASE.prepare(
      `SELECT event_kind FROM audit_entity_history_v WHERE subject_kind = 'tenancy' AND subject_id = 'ten'`,
    ).first(),
  ).toEqual({ event_kind: 'tenancy_ended' });
});

it('still allows exactly one subject per row', async () => {
  await expect(
    env.DATABASE.prepare(
      `INSERT INTO roster_change_subjects (id, event_id, role, lot_id, tenancy_id)
       VALUES ('sub-two', 'ev-old', 'related', 'lot-a', 'ten')`,
    ).run(),
  ).rejects.toThrow(/CHECK constraint failed/);
  await expect(
    env.DATABASE.prepare(
      `INSERT INTO roster_change_subjects (id, event_id, role) VALUES ('sub-none', 'ev-old', 'related')`,
    ).run(),
  ).rejects.toThrow(/CHECK constraint failed/);
});

it('refuses a Tenancy that ends before it starts, an end without a reason, or an unknown reason', async () => {
  const insert = (id: string, columns: string, values: string) =>
    env.DATABASE.prepare(
      `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id, start_day, scheduled_end_day, created_at, updated_at${columns})
       VALUES ('${id}', 'tenant', 'lot-a', 'own', '2026-01-01', '2027-01-01', 1, 1${values})`,
    ).run();
  await expect(
    env.DATABASE.prepare(
      `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id, start_day, scheduled_end_day, created_at, updated_at)
       VALUES ('x1', 'tenant', 'lot-a', 'own', '2026-01-01', '2026-01-01', 1, 1)`,
    ).run(),
  ).rejects.toThrow(/CHECK constraint failed/);
  await expect(
    insert(
      'x2',
      ', actual_end_day, end_reason',
      ", '2025-12-31', 'board_ended'",
    ),
  ).rejects.toThrow(/CHECK constraint failed/);
  await expect(
    insert(
      'x3',
      ', actual_end_day, end_reason',
      ", '2027-01-01', 'board_ended'",
    ),
  ).rejects.toThrow(/CHECK constraint failed/);
  await expect(
    insert('x4', ', actual_end_day', ", '2026-06-01'"),
  ).rejects.toThrow(/CHECK constraint failed/);
  await expect(
    insert('x5', ', actual_end_day, end_reason', ", '2026-06-01', 'moved_out'"),
  ).rejects.toThrow(/CHECK constraint failed/);
  // An end on the start day is a Tenancy that never ran, and is allowed.
  await insert(
    'ok',
    ', actual_end_day, end_reason',
    ", '2026-01-01', 'basis_ended'",
  );
});
