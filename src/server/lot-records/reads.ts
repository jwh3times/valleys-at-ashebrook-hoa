import { lotAuthorityCoversRecordDay } from '../roster/authority';
import type {
  LotRecordAction,
  LotRecordType,
  LotViolationCategory,
  LotViolationStatus,
} from '../../lib/types';

/**
 * LOT RECORD READS (ADR 0024, #291).
 *
 * These live here rather than in `content/reads.ts` because they are scoped by
 * a different thing. `reads.ts` filters rows by the caller's content TIER —
 * how sensitive a shared row is. A Lot Record's audience is decided by its
 * `lot_id` joined against the party roster: whoever holds Lot Authority over
 * that one Lot, plus Board Access.
 *
 * Three rules hold for every export below, and the suites in
 * `test/server/lot-records-*.test.ts` are what keep them true:
 *
 * 1. **Homeowner reads take `personId`, never a caller-supplied lot list.** An
 *    array of lot ids handed in by the caller is a claim; `personId` plus the
 *    Association Day is a fact the roster can check. The scoping predicate is
 *    embedded in the `WHERE` clause, so the database never returns a row the
 *    caller may not read. Nothing is filtered in TypeScript afterwards.
 * 2. **Board reads are named `fetchAdminLot*`** and are reachable only from a
 *    `requireBoard`-gated route, following the naming convention
 *    `reads-all-scoped.test.ts` enforces for `reads.ts`.
 * 3. **A row the caller may not read is absent, not redacted.** A single-record
 *    read answers `null`, which its route and page turn into a generic 404 —
 *    never a 403, which would confirm the record exists.
 *
 * Board-only fields are projected out for the homeowner caller in the SQL
 * itself, not hidden by the component: `internalNote` comes back `null` because
 * the query never selects the column.
 */

/** A violation as its Lot's own holders see it. `internalNote` is never here. */
export interface MemberLotViolation {
  id: string;
  lotId: string;
  category: LotViolationCategory;
  effectiveDay: string;
  summary: string;
  status: Exclude<LotViolationStatus, 'voided'>;
  recordedAt: Date;
}

/** A violation as the board sees it: every field, every status. */
export interface AdminLotViolation extends Omit<MemberLotViolation, 'status'> {
  internalNote: string | null;
  status: LotViolationStatus;
  createdBy: string;
}

export interface LotRecordEvent {
  id: string;
  recordType: LotRecordType;
  recordId: string;
  action: LotRecordAction;
  actingAccountId: string;
  reasonCode: string | null;
  recordedAt: Date;
}

interface ViolationRow {
  id: string;
  lot_id: string;
  category: LotViolationCategory;
  effective_day: string;
  summary: string;
  internal_note: string | null;
  status: LotViolationStatus;
  created_by: string;
  created_at: number;
}

const VIOLATION_COLUMNS = `id, lot_id, category, effective_day, summary,
            status, created_by, created_at`;

const toMemberViolation = (r: ViolationRow): MemberLotViolation => ({
  id: r.id,
  lotId: r.lot_id,
  category: r.category,
  effectiveDay: r.effective_day,
  summary: r.summary,
  status: r.status as Exclude<LotViolationStatus, 'voided'>,
  recordedAt: new Date(r.created_at),
});

const toAdminViolation = (r: ViolationRow): AdminLotViolation => ({
  ...toMemberViolation(r),
  status: r.status,
  internalNote: r.internal_note ?? null,
  createdBy: r.created_by,
});

/**
 * The scoping predicate every homeowner read embeds: the caller holds Lot
 * Authority over the row's Lot today, AND the row is dated on or after the
 * start of that authority.
 *
 * Both halves come from one builder in `roster/authority.ts`, so this cannot
 * drift from the rule the mutation boundaries and the board-qualification check
 * already use. A voided row is excluded here rather than by each caller: a
 * record voided during error correction stays board-visible history, and it has
 * to disappear from this surface by construction rather than by everyone
 * remembering a filter.
 */
function memberViolationScope(personId: string, associationDay: string) {
  const authority = lotAuthorityCoversRecordDay(
    { value: personId },
    { column: 'lot_violations.lot_id' },
    associationDay,
    { column: 'lot_violations.effective_day' },
  );
  return {
    sql: `${authority.sql} AND lot_violations.status <> 'voided'`,
    binds: authority.binds,
  };
}

/**
 * Every violation the caller's own Lots carry, newest first.
 *
 * An unlinked Account — `personId` null, which is every caller under
 * `cutover_mode = legacy` and any Account with no Person Link — reads nothing.
 * There is no Person to scope by, which is the same deliberate refusal
 * `/api/member/roster-self` gives.
 */
export async function fetchMemberLotViolations(
  env: Env,
  personId: string | null,
  associationDay: string,
): Promise<MemberLotViolation[]> {
  if (!personId) return [];
  const scope = memberViolationScope(personId, associationDay);
  const { results } = await env.DATABASE.prepare(
    `SELECT ${VIOLATION_COLUMNS}
       FROM lot_violations
      WHERE ${scope.sql}
      ORDER BY effective_day DESC, created_at DESC`,
  )
    .bind(...scope.binds)
    .all<ViolationRow>();
  return results.map(toMemberViolation);
}

/**
 * One violation, or `null` when the caller may not read it — another Lot's
 * record, a record from before their period, a voided one, or one that does not
 * exist at all. All four answer the same way on purpose, so the response never
 * confirms that such a record exists.
 */
export async function fetchMemberLotViolation(
  env: Env,
  personId: string | null,
  associationDay: string,
  id: string,
): Promise<MemberLotViolation | null> {
  if (!personId) return null;
  const scope = memberViolationScope(personId, associationDay);
  const row = await env.DATABASE.prepare(
    `SELECT ${VIOLATION_COLUMNS}
       FROM lot_violations
      WHERE id = ? AND ${scope.sql}`,
  )
    .bind(id, ...scope.binds)
    .first<ViolationRow>();
  return row ? toMemberViolation(row) : null;
}

/**
 * Every violation for one Lot, or for the whole association when `lotId` is
 * omitted — board-only, including voided rows and board-only notes. Unscoped by
 * construction, so it is reachable only from a `requireBoard`-gated route.
 */
export async function fetchAdminLotViolations(
  env: Env,
  lotId?: string,
): Promise<AdminLotViolation[]> {
  const statement = env.DATABASE.prepare(
    `SELECT ${VIOLATION_COLUMNS}, internal_note
       FROM lot_violations
       ${lotId === undefined ? '' : 'WHERE lot_id = ?'}
      ORDER BY effective_day DESC, created_at DESC`,
  );
  const { results } = await (
    lotId === undefined ? statement : statement.bind(lotId)
  ).all<ViolationRow>();
  return results.map(toAdminViolation);
}

/**
 * The event log for one Lot Record, oldest first — board-only.
 *
 * The subject is `(recordType, recordId)` with no foreign key, because one
 * table serves several subject tables, so both halves are always required here:
 * a `recordId` on its own is not a key.
 */
export async function fetchAdminLotRecordEvents(
  env: Env,
  recordType: LotRecordType,
  recordId: string,
): Promise<LotRecordEvent[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT id, record_type, record_id, action, acting_account_id,
            reason_code, recorded_at
       FROM lot_record_events
      WHERE record_type = ? AND record_id = ?
      ORDER BY recorded_at ASC, id ASC`,
  )
    .bind(recordType, recordId)
    .all<{
      id: string;
      record_type: LotRecordType;
      record_id: string;
      action: LotRecordAction;
      acting_account_id: string;
      reason_code: string | null;
      recorded_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    recordType: r.record_type,
    recordId: r.record_id,
    action: r.action,
    actingAccountId: r.acting_account_id,
    reasonCode: r.reason_code,
    recordedAt: new Date(r.recorded_at),
  }));
}
