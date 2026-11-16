// Ending a Tenancy before its scheduled end day (ADR 0028, #599).
//
// A Tenancy ends early in three ways: a current holder of Lot Authority over
// its Lot ends it, the Board ends it, or the Ownership it rests on ends and
// takes it along (`tenancyLossStatements`). All three end it the same way,
// written once here: on the later of its start day and the end day, so one
// that has not begun ends on its start day and never runs; only while it is
// neither voided nor already ended and the end falls before its scheduled end
// day; and recorded as one `tenancy_ended` Roster Change.

import { lotAuthorityBasis, lotAuthorityExists } from './authority';
import {
  AuditCorrelation,
  OPERATOR_OBSERVATION,
  operationKey,
  updatedRowGuard,
  type Evidence,
  type SqlGuard,
} from './audit';
import type { TenancyEndReason } from '../db/roster-schema';

export interface TenancyEndStatementInput {
  database: D1Database;
  correlation: AuditCorrelation;
  tenancy: { id: string; lotId: string; tenantPersonId: string };
  /** The day it ends, unless it starts later. */
  day: string;
  reason: TenancyEndReason;
  /** Stamped as `ended_by_account_id`. */
  actorAccountId: string;
  nowMs: number;
  evidence: Evidence;
  /** A further condition the end is written under, re-checked in the
   * statement itself. */
  guard?: SqlGuard;
  /** An automatic consequence of the command, rather than its own act. */
  automaticCause?: string;
}

/**
 * The guarded UPDATE that ends one Tenancy, for the caller's batch, and its
 * `tenancy_ended` Roster Change recorded on the caller's correlation. A
 * Tenancy the UPDATE does not end gets no Roster Change.
 */
export function tenancyEndStatement(
  input: TenancyEndStatementInput,
): D1PreparedStatement {
  const guard = input.guard ?? { sql: '1', binds: [] };
  const statement = input.database
    .prepare(
      `UPDATE tenancies
       SET actual_end_day = MAX(start_day, ?), end_reason = ?,
           ended_by_account_id = ?, updated_at = ?
       WHERE id = ? AND voided_at IS NULL AND actual_end_day IS NULL
         AND MAX(start_day, ?) < scheduled_end_day
         AND (${guard.sql})`,
    )
    .bind(
      input.day,
      input.reason,
      input.actorAccountId,
      input.nowMs,
      input.tenancy.id,
      input.day,
      ...guard.binds,
    );
  input.correlation.event({
    kind: 'tenancy_ended',
    ...(input.automaticCause !== undefined
      ? { actor: { kind: 'automatic' as const, cause: input.automaticCause } }
      : {}),
    guard: updatedRowGuard(
      'tenancies',
      input.tenancy.id,
      input.nowMs,
      ' AND end_reason = ?',
      [input.reason],
    ),
    detail: {
      family: 'roster_change',
      effective: { day: input.day },
      reason: input.reason,
      evidence: input.evidence,
      subjects: [
        { column: 'tenancy_id', id: input.tenancy.id, role: 'ended' },
        { column: 'lot_id', id: input.tenancy.lotId, role: 'related' },
        {
          column: 'party_id',
          id: input.tenancy.tenantPersonId,
          role: 'related',
        },
      ],
    },
  });
  return statement;
}

/** Who ends the Tenancy. A board caller's authority is its route's guard; a
 * holder of Lot Authority is checked here, before the write and inside it. */
export type TenancyEnder =
  | { kind: 'board'; accountId: string; evidence: Evidence }
  | { kind: 'lot-authority'; accountId: string; personId: string };

export interface EndTenancyInput {
  tenancyId: string;
  /** The Association Day. */
  today: string;
  by: TenancyEnder;
}

export type TenancyEndRefusal =
  'not-found' | 'voided' | 'already-ended' | 'end-day-reached' | 'lost-race';

export type EndTenancyResult =
  { ok: true } | { ok: false; refusal: TenancyEndRefusal };

/** Ends a current or upcoming Tenancy today, in one batch with its Roster
 * Change. */
export async function endTenancy(
  database: D1Database,
  input: EndTenancyInput,
): Promise<EndTenancyResult> {
  const row = await database
    .prepare(
      `SELECT lot_id, tenant_person_id, scheduled_end_day,
              voided_at IS NOT NULL AS voided,
              actual_end_day IS NOT NULL AS ended
       FROM tenancies WHERE id = ?`,
    )
    .bind(input.tenancyId)
    .first<{
      lot_id: string;
      tenant_person_id: string;
      scheduled_end_day: string;
      voided: number;
      ended: number;
    }>();
  if (!row) return { ok: false, refusal: 'not-found' };
  const { by } = input;
  // Outside the person's Lots, a Tenancy is not there at all.
  if (
    by.kind === 'lot-authority' &&
    !(await lotAuthorityBasis(database, by.personId, row.lot_id, input.today))
  )
    return { ok: false, refusal: 'not-found' };
  if (row.voided === 1) return { ok: false, refusal: 'voided' };
  if (row.ended === 1) return { ok: false, refusal: 'already-ended' };
  // Unended but past its end day: it has lapsed, with nothing left to end.
  if (row.scheduled_end_day <= input.today)
    return { ok: false, refusal: 'end-day-reached' };

  const nowMs = Date.now();
  const correlation = new AuditCorrelation(database, {
    operationKey:
      by.kind === 'board'
        ? operationKey('tenancies', 'end')
        : operationKey('member-tenancies', 'end'),
    actorAccountId: by.accountId,
    nowMs,
  });
  const primary = tenancyEndStatement({
    database,
    correlation,
    tenancy: {
      id: input.tenancyId,
      lotId: row.lot_id,
      tenantPersonId: row.tenant_person_id,
    },
    day: input.today,
    reason: by.kind === 'board' ? 'board_ended' : 'owner_ended',
    actorAccountId: by.accountId,
    nowMs,
    ...(by.kind === 'board'
      ? { evidence: by.evidence }
      : {
          evidence: OPERATOR_OBSERVATION,
          guard: lotAuthorityExists(
            { value: by.personId },
            { column: 'tenancies.lot_id' },
            input.today,
          ),
        }),
  });
  const [result] = await database.batch([primary, ...correlation.statements]);
  if (result.meta.changes !== 1) return { ok: false, refusal: 'lost-race' };
  return { ok: true };
}
