import { env } from 'cloudflare:test';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import { accessGrants, parties } from '../../src/server/db/roster-schema';
import {
  truncateAll,
  seedProperty,
  seedLotAuthority,
  seedPerson,
} from './fixtures';
import { seedAccountLink } from './roster-fixtures';

// Shared setup for the Tenancy route tests (#294 slice 2): a board operator
// with a real System Administrator grant (the transfer re-checks it in its
// batch), one Lot owned by `owner` from 2025-01-01 (Ownership
// `owner-lot-own`), and a tenant Person who owns nothing.

const LEDGER = [
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'board_service_change_subjects',
  'roster_change_subjects',
  'board_service_changes',
  'roster_changes',
  'identity_events',
  'access_events',
  'review_events',
  'redaction_tasks',
  'roster_redactions',
  'review_flags',
  'audit_events',
  'access_grants',
  'board_office_assignments',
  'board_terms',
  'person_links',
  'person_verifications',
  'representation_lots',
  'representations',
  'contact_methods',
  'organizations',
];

export async function resetTenancyWorld(): Promise<void> {
  await env.DATABASE.prepare('DELETE FROM cutover_settings').run();
  for (const table of LEDGER) {
    // A caused event cites its root, so the roots go last.
    if (table === 'audit_events')
      await env.DATABASE.prepare(
        'DELETE FROM audit_events WHERE correlation_sequence > 0',
      ).run();
    await env.DATABASE.prepare(`DELETE FROM "${table}"`).run();
  }
  await getDb(env).update(parties).set({ consolidatedIntoPartyId: null });
  await truncateAll();
  await getDb(env)
    .insert(users)
    .values({
      id: 'board',
      name: 'Board operator',
      email: 'board@example.test',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await seedPerson('operator');
  await seedAccountLink('board', 'operator');
  await getDb(env)
    .insert(accessGrants)
    .values({
      id: 'operator-grant',
      accountId: 'board',
      grantType: 'system_admin',
      startedAt: new Date('2025-01-01'),
      grantReason: 'technical_administration',
    });
  await seedProperty('lot');
  await seedLotAuthority('owner', 'lot', { startDay: '2025-01-01' });
  await seedPerson('tenant');
}

export interface TenancyRow {
  id: string;
  start_day: string;
  scheduled_end_day: string;
  actual_end_day: string | null;
  end_reason: string | null;
  ended_by_account_id: string | null;
  voided_at: number | null;
}

export async function seedTenancy(
  id: string,
  overrides: {
    tenantPersonId?: string;
    lotId?: string;
    basisOwnershipId?: string;
    startDay?: string;
    scheduledEndDay?: string;
    actualEndDay?: string;
    voided?: boolean;
  } = {},
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id,
       start_day, scheduled_end_day, actual_end_day, end_reason, voided_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  )
    .bind(
      id,
      overrides.tenantPersonId ?? 'tenant',
      overrides.lotId ?? 'lot',
      overrides.basisOwnershipId ?? 'owner-lot-own',
      overrides.startDay ?? '2025-06-01',
      overrides.scheduledEndDay ?? '2099-01-01',
      overrides.actualEndDay ?? null,
      overrides.actualEndDay ? 'board_ended' : null,
      overrides.voided ? 1 : null,
    )
    .run();
}

export async function tenancy(id: string): Promise<TenancyRow> {
  const row = await env.DATABASE.prepare(
    `SELECT id, start_day, scheduled_end_day, actual_end_day, end_reason,
            ended_by_account_id, voided_at
     FROM tenancies WHERE id = ?`,
  )
    .bind(id)
    .first<TenancyRow>();
  if (!row) throw new Error(`no tenancy ${id}`);
  return row;
}

/** The ledger rows naming a Tenancy, oldest first. */
export async function tenancyEvents(id: string) {
  const { results } = await env.DATABASE.prepare(
    `SELECT e.event_kind, e.actor_kind, e.automatic_cause, rc.reason_code,
            rc.effective_day, s.role
     FROM roster_change_subjects s
     JOIN audit_events e ON e.id = s.event_id
     JOIN roster_changes rc ON rc.event_id = e.id
     WHERE s.tenancy_id = ?
     ORDER BY e.ledger_sequence`,
  )
    .bind(id)
    .all();
  return results;
}
