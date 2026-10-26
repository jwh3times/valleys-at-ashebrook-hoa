// Tenant Access (ADR 0028, #294; spec docs/specs/2026-10-20-tenant-access-design.md).
//
// A Tenancy is its own relation. Nothing that answers Lot Authority joins it:
// `authority.ts`, `board-consequences.ts` and `LOT_SQL` never name the table,
// which `test/unit/tenancy-not-lot-authority.test.ts` pins. This module holds
// the gate, the one currency rule, and the consequences of losing a basis.

import type { AuditCorrelation, SqlGuard } from './audit';
import { getSiteSettings } from '../content/settings';
import type { SiteSettings } from '../../lib/types';

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
 * Nor does refusing or withdrawing a request, so a pending request's name and
 * contact can always be cleared (review decision, 2026-10-25).
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
 * The read-time half of the same gate, for a route or page deciding whether a
 * gated action exists at all; the mutation re-checks
 * `TENANT_ACCESS_ENABLED_SQL` inside its own statement. A copy of
 * `lotRecordsAvailable`, failing closed the same way.
 */
export async function tenantAccessAvailable(env: Env): Promise<boolean> {
  return tenantAccessVisible(await getSiteSettings(env));
}

/** The same answer for a caller that already holds the settings. */
export function tenantAccessVisible(
  site: Pick<SiteSettings, 'officialMode' | 'tenantAccessEnabled'>,
): boolean {
  return site.officialMode && site.tenantAccessEnabled;
}

/**
 * The longest a Tenancy may run: its scheduled end is at most this many
 * months after its start. Checked in the mutation SQL, never a CHECK, because
 * it is a policy number the board may change (spec decision 1).
 */
export const TENANCY_MAX_MONTHS = 13;

/**
 * The latest scheduled end day allowed for a Tenancy starting on `startDay`.
 * `setUTCMonth` rolls an overflowing day forward exactly as SQLite's
 * `date(d, '+13 months')` does, so this answer and the SQL re-check agree.
 */
export function latestTenancyEndDay(startDay: string): string {
  const d = new Date(`${startDay}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + TENANCY_MAX_MONTHS);
  return d.toISOString().slice(0, 10);
}

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
    AND ${basisCurrentSql(`${t}.basis_ownership_id`, `${t}.lot_id`, day)})`;
}

/**
 * A Tenancy that is current on `day`, or will be once it starts: the kind an
 * invitation may be sent for and claimed. Pass `day` as for
 * `tenancyCurrentSql`.
 */
export function tenancyCurrentOrUpcomingSql(t: string, day: string): string {
  return `(${tenancyCurrentSql(t, day)}
    OR (${t}.start_day > ${day} AND ${tenancyCurrentSql(t, `${t}.start_day`)}))`;
}

/**
 * The basis half of `tenancyCurrentSql`, for a request as well as a Tenancy:
 * Ownership `ownership` is unvoided, on Lot `lot` and current on `day`, and
 * that Lot is not retired.
 *
 * `day` appears twice: pass a numbered parameter or a column, or a bare `?`
 * bound twice.
 */
export function basisCurrentSql(
  ownership: string,
  lot: string,
  day: string,
): string {
  return `EXISTS (
      SELECT 1 FROM ownerships tb JOIN lots tl ON tl.id = tb.lot_id
      WHERE tb.id = ${ownership}
        AND tb.lot_id = ${lot}
        AND tb.voided_at IS NULL
        AND (tb.start_day IS NULL OR tb.start_day <= ${day})
        AND (tb.end_day IS NULL OR ${day} < tb.end_day)
        AND tl.retired_at IS NULL
    )`;
}

/**
 * The SET clause that clears a request's tenant name and contact. A request
 * holds them only while it is open (spec decision 3, and migration 0044's
 * `contact_shape` CHECK), so every decision — approve, refuse, withdraw —
 * carries this.
 */
export const CLEAR_REQUEST_CONTACT_SQL =
  'tenant_name = NULL, channel = NULL, contact_value = NULL, contact_normalized = NULL';

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
