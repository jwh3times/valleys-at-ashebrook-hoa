// Tenant Access (ADR 0028, #294; spec docs/specs/2026-10-20-tenant-access-design.md).
//
// A Tenancy is its own relation. Nothing that answers Lot Authority joins it:
// `authority.ts`, `board-consequences.ts` and `LOT_SQL` never name the table,
// which `test/unit/tenancy-not-lot-authority.test.ts` pins. This module holds
// the gate, the one currency rule, and the consequences of losing a basis.

import type { AuditCorrelation, SqlGuard } from './audit';

/**
 * Both gates, inside SQL: `officialMode` AND `tenantAccessEnabled`, each a
 * literal JSON `true`. A copy of `LOT_RECORDS_ENABLED_SQL` (see
 * `lot-records/gate.ts` for why `json_type` and not `json_extract`). A missing
 * row, a missing key or malformed JSON all read as off.
 *
 * Every tenant mutation re-checks it inside its own statement, and the
 * document predicate embeds it, so a tenant stops seeing Tenant-Visible
 * documents on the first request after either gate turns off. Ending or
 * voiding a Tenancy never checks it: ending access must not wait on a gate.
 */
export const TENANT_ACCESS_ENABLED_SQL = `
  EXISTS (
    SELECT 1 FROM settings
    WHERE key = 'site'
      AND CASE WHEN json_valid(value)
        THEN json_type(value, '$.officialMode') = 'true'
         AND json_type(value, '$.tenantAccessEnabled') = 'true'
        ELSE 0
      END
  )
` as const;

/**
 * The one definition of a current Tenancy, for every reader: the row aliased
 * `t` is current on `day` when it is not voided, `day` falls inside
 * [start, effective end), its basis Ownership is unvoided, on the same Lot and
 * current on `day`, and its Lot is not retired.
 *
 * `day` appears several times, so pass a numbered parameter (`?2`) or a
 * literal, never a bare `?`.
 *
 * The basis is re-checked here rather than trusted to the mutation that ends
 * it: a Tenancy whose Ownership ended stops granting anything on that day even
 * if the consequence write never landed, which `tenancy_on_ended_basis` would
 * then report.
 */
export function tenancyCurrentSql(t: string, day: string): string {
  return `(${t}.voided_at IS NULL
    AND ${t}.start_day <= ${day}
    AND ${day} < COALESCE(${t}.actual_end_day, ${t}.scheduled_end_day)
    AND EXISTS (
      SELECT 1 FROM ownerships tb
      WHERE tb.id = ${t}.basis_ownership_id
        AND tb.lot_id = ${t}.lot_id
        AND tb.voided_at IS NULL
        AND (tb.start_day IS NULL OR tb.start_day <= ${day})
        AND (tb.end_day IS NULL OR ${day} < tb.end_day)
    )
    AND EXISTS (
      SELECT 1 FROM lots tl WHERE tl.id = ${t}.lot_id AND tl.retired_at IS NULL
    ))`;
}

export interface TenancyLossInput {
  database: D1Database;
  nowMs: number;
  /** The Ownerships the command ends, voids or transfers away. */
  ownershipIds: string[];
  /** The day the basis ended: the Ownership's end day, the transfer's
   * effective day, the retirement day, or today for a void. */
  day: string;
  reason: 'basis_ended' | 'lot_retired';
  /** The command's success marker: a Tenancy ends only if the command did. */
  rootGuard: SqlGuard;
  correlation: AuditCorrelation;
  /** `automatic_cause` label for the caused ledger events. */
  cause: string;
  /** The commanding account, stamped as `ended_by_account_id`. */
  actorAccountId: string;
}

export interface EndingTenancy {
  id: string;
  tenantPersonId: string;
  lotId: string;
  scheduledEndDay: string;
  /** The end it will receive: the later of its start and the loss day. */
  endDay: string;
}

/**
 * Ends every current or upcoming Tenancy whose basis is one of the command's
 * Ownerships (spec decision 7), as caused Roster Changes on the command's
 * correlation. A Tenancy ends on the later of its start and `day`, so one that
 * had not begun ends on its start day and never ran.
 *
 * Enumerated pre-batch, like `lossConsequences`; each UPDATE re-checks its
 * own row inside the batch. A Tenancy recorded between the read and the batch
 * is missed, but it grants nothing (its basis is no longer current) and the
 * `tenancy_on_ended_basis` invariant reports it.
 *
 * No Review Flag: the access a tenant had before the change was real.
 */
export async function tenancyLossStatements(
  input: TenancyLossInput,
): Promise<{ statements: D1PreparedStatement[]; ending: EndingTenancy[] }> {
  if (input.ownershipIds.length === 0) return { statements: [], ending: [] };

  const placeholders = input.ownershipIds.map(() => '?').join(', ');
  const found = await input.database
    .prepare(
      `SELECT id, tenant_person_id, lot_id, scheduled_end_day,
              MAX(start_day, ?) AS end_day
       FROM tenancies
       WHERE basis_ownership_id IN (${placeholders})
         AND voided_at IS NULL AND actual_end_day IS NULL
         AND MAX(start_day, ?) < scheduled_end_day
       ORDER BY start_day, id`,
    )
    .bind(input.day, ...input.ownershipIds, input.day)
    .all<{
      id: string;
      tenant_person_id: string;
      lot_id: string;
      scheduled_end_day: string;
      end_day: string;
    }>();

  const statements: D1PreparedStatement[] = [];
  const ending: EndingTenancy[] = [];
  for (const row of found.results) {
    statements.push(
      input.database
        .prepare(
          `UPDATE tenancies
           SET actual_end_day = MAX(start_day, ?), end_reason = ?,
               ended_by_account_id = ?, updated_at = ?
           WHERE id = ? AND voided_at IS NULL AND actual_end_day IS NULL
             AND MAX(start_day, ?) < scheduled_end_day
             AND (${input.rootGuard.sql})`,
        )
        .bind(
          input.day,
          input.reason,
          input.actorAccountId,
          input.nowMs,
          row.id,
          input.day,
          ...input.rootGuard.binds,
        ),
    );
    input.correlation.event({
      kind: 'tenancy_ended',
      actor: { kind: 'automatic', cause: input.cause },
      guard: {
        sql: `EXISTS (SELECT 1 FROM tenancies WHERE id = ? AND updated_at = ? AND end_reason = ?)`,
        binds: [row.id, input.nowMs, input.reason],
      },
      detail: {
        family: 'roster_change',
        effective: { day: input.day },
        reason: input.reason,
        evidence: { kind: 'operator_observation' },
        subjects: [
          { column: 'tenancy_id', id: row.id, role: 'ended' },
          { column: 'lot_id', id: row.lot_id, role: 'related' },
          { column: 'party_id', id: row.tenant_person_id, role: 'related' },
        ],
      },
    });
    ending.push({
      id: row.id,
      tenantPersonId: row.tenant_person_id,
      lotId: row.lot_id,
      scheduledEndDay: row.scheduled_end_day,
      endDay: row.end_day,
    });
  }
  return { statements, ending };
}
