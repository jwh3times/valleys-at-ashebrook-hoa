import {
  lotAuthorityCoversRecordDay,
  lotAuthorityExists,
} from '../roster/authority';
import type {
  DuesChargeCategory,
  DuesEntrySource,
  DuesLedgerKind,
  DuesPaymentMethod,
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
 * Resolves the caller's Person one hop through a consolidation, exactly as
 * `LOT_SQL`'s `me` CTE does, and is prepended to every homeowner read.
 *
 * `AuthContext.personId` is the raw `person_links.person_id`, while the
 * `lotIds` that decided this caller is a member were computed from
 * `COALESCE(consolidated_into_party_id, id)`. Consolidation only MARKS the
 * duplicate — `POST /api/admin/roster-parties` moves no Ownership row — so
 * without this, an account linked to a duplicate Party would be told it holds
 * the survivor's Lots and then shown none of their records: an empty page
 * indistinguishable from a Lot with nothing recorded, which is the worst
 * answer this surface can give.
 *
 * `roster/authority.ts` deliberately does NOT canonicalize, and that is right
 * for what it answers there — a proxy grantor or a ballot caster IS the Party
 * named on the record. The canonicalization belongs here, where the question
 * is instead "which Person is this ACCOUNT", the same question `LOT_SQL` asks.
 *
 * One hop only, which the consolidate route enforces by refusing a survivor
 * that is itself consolidated.
 */
const CALLER_PERSON_CTE = `WITH me AS (
    SELECT COALESCE(pa.consolidated_into_party_id, pa.id) AS party_id
    FROM parties pa
    WHERE pa.id = ?
  )`;

/** How the predicate below refers to that resolved Person. */
const CALLER_PERSON = { column: '(SELECT party_id FROM me)' } as const;

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
function memberViolationScope(associationDay: string) {
  const authority = lotAuthorityCoversRecordDay(
    CALLER_PERSON,
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
  const scope = memberViolationScope(associationDay);
  const { results } = await env.DATABASE.prepare(
    `${CALLER_PERSON_CTE}
     SELECT ${VIOLATION_COLUMNS}
       FROM lot_violations
      WHERE ${scope.sql}
      ORDER BY effective_day DESC, created_at DESC`,
  )
    .bind(personId, ...scope.binds)
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
  const scope = memberViolationScope(associationDay);
  const row = await env.DATABASE.prepare(
    `${CALLER_PERSON_CTE}
     SELECT ${VIOLATION_COLUMNS}
       FROM lot_violations
      WHERE id = ? AND ${scope.sql}`,
  )
    .bind(personId, id, ...scope.binds)
    .first<ViolationRow>();
  return row ? toMemberViolation(row) : null;
}

/**
 * The addresses of the Lots this caller holds today, keyed by Lot id.
 *
 * `content/reads.ts`'s `fetchMemberLots` would answer a similar question, but
 * it takes a caller-supplied lot array and returns every co-owner's name
 * alongside — roster PII a Lot Record surface has no use for. This asks the
 * roster the same way the record reads do, from `personId`, and returns
 * nothing else.
 */
export async function fetchMemberLotAddresses(
  env: Env,
  personId: string | null,
  associationDay: string,
): Promise<Map<string, string>> {
  if (!personId) return new Map();
  // The plain authority question, NOT the period-bounded one: an address is
  // not a record with a date, and the bound reads `effective_day >=
  // start_day`, so feeding it a sentinel day would exclude every Lot whose
  // ownership has a known start.
  const authority = lotAuthorityExists(
    CALLER_PERSON,
    { column: 'properties.id' },
    associationDay,
  );
  const { results } = await env.DATABASE.prepare(
    `${CALLER_PERSON_CTE}
     SELECT properties.id AS id, properties.address AS address
       FROM properties
      WHERE ${authority.sql}
      ORDER BY properties.address`,
  )
    .bind(personId, ...authority.binds)
    .all<{ id: string; address: string }>();
  return new Map(results.map((r) => [r.id, r.address]));
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

/**
 * THE DUES LEDGER READ (ADR 0025, #295), and the one place ADR 0024's rule for
 * a RUNNING FIGURE is implemented.
 *
 * A violation before the reader's period is simply omitted. A ledger entry
 * cannot be, because the balance is the sum of every entry ever posted to the
 * Lot: dropping the earlier ones would show a partial balance, wrong in
 * exactly the way #295 warns about — a homeowner reading "you owe $40" when
 * the Lot owes $1,240.
 *
 * So the earlier entries are COLLAPSED rather than dropped. Their sum comes
 * back as `openingBalanceCents`, and the itemized entries are the reader's
 * own. The seller's itemized history stays invisible; the figure stays whole.
 *
 * Both halves use the same two predicates as every other Lot Record read — the
 * unbounded authority question for "is this my Lot", the period-bounded one
 * for "is this mine to read in detail" — so the split cannot drift from the
 * rule it implements.
 */
export interface MemberDuesEntry {
  id: string;
  lotId: string;
  kind: DuesLedgerKind;
  amountCents: number;
  effectiveDay: string;
  description: string;
  category: DuesChargeCategory | null;
  method: DuesPaymentMethod | null;
}

export interface MemberLotLedger {
  lotId: string;
  /** The sum of everything before this reader's period, as one line. */
  openingBalanceCents: number;
  /** The first itemized day, which the opening line is "before". */
  openingBeforeDay: string | null;
  entries: MemberDuesEntry[];
  /** Opening plus every itemized entry: what the Lot owes today. */
  balanceCents: number;
}

/** A ledger entry as the board sees it: every column. */
export interface AdminDuesEntry extends MemberDuesEntry {
  reference: string | null;
  source: DuesEntrySource;
  paymentId: string | null;
  reversesEntryId: string | null;
  recordedBy: string | null;
  recordedAt: Date;
  operationKey: string;
}

interface LedgerRow {
  id: string;
  lot_id: string;
  kind: DuesLedgerKind;
  amount_cents: number;
  effective_day: string;
  description: string;
  category: DuesChargeCategory | null;
  method: DuesPaymentMethod | null;
}

const LEDGER_COLUMNS = `id, lot_id, kind, amount_cents, effective_day,
            description, category, method`;

const toMemberEntry = (r: LedgerRow): MemberDuesEntry => ({
  id: r.id,
  lotId: r.lot_id,
  kind: r.kind,
  amountCents: r.amount_cents,
  effectiveDay: r.effective_day,
  description: r.description,
  category: r.category,
  method: r.method,
});

/**
 * Every ledger entry the reader may itemize, with the earlier ones collapsed
 * into an opening balance, per Lot.
 *
 * Two statements rather than one: the detail rows, and the sums of what came
 * before. One query could produce both with a window function, at the cost of
 * a shape nobody can check by reading it — and this is the query whose
 * correctness a homeowner will one day dispute.
 */
export async function fetchMemberDuesLedger(
  env: Env,
  personId: string | null,
  associationDay: string,
): Promise<MemberLotLedger[]> {
  if (!personId) return [];

  const detail = lotAuthorityCoversRecordDay(
    CALLER_PERSON,
    { column: 'dues_ledger_entries.lot_id' },
    associationDay,
    { column: 'dues_ledger_entries.effective_day' },
  );
  const { results: rows } = await env.DATABASE.prepare(
    `${CALLER_PERSON_CTE}
     SELECT ${LEDGER_COLUMNS}
       FROM dues_ledger_entries
      WHERE ${detail.sql}
      ORDER BY effective_day ASC, recorded_at ASC`,
  )
    .bind(personId, ...detail.binds)
    .all<LedgerRow>();

  // The complement: entries on Lots this caller holds TODAY that fall before
  // their own period. `holds` is the unbounded authority question, so an entry
  // on a Lot they do not hold is in neither set — not itemized, and not summed
  // into anything either.
  const holds = lotAuthorityExists(
    CALLER_PERSON,
    { column: 'dues_ledger_entries.lot_id' },
    associationDay,
  );
  const alsoDetail = lotAuthorityCoversRecordDay(
    CALLER_PERSON,
    { column: 'dues_ledger_entries.lot_id' },
    associationDay,
    { column: 'dues_ledger_entries.effective_day' },
  );
  const { results: openings } = await env.DATABASE.prepare(
    `${CALLER_PERSON_CTE}
     SELECT dues_ledger_entries.lot_id AS lot_id,
            SUM(dues_ledger_entries.amount_cents) AS opening_cents
       FROM dues_ledger_entries
      WHERE ${holds.sql}
        AND NOT (${alsoDetail.sql})
      GROUP BY dues_ledger_entries.lot_id`,
  )
    .bind(personId, ...holds.binds, ...alsoDetail.binds)
    .all<{ lot_id: string; opening_cents: number | null }>();

  const byLot = new Map<string, MemberLotLedger>();
  const lotOf = (lotId: string): MemberLotLedger => {
    const existing = byLot.get(lotId);
    if (existing) return existing;
    const created: MemberLotLedger = {
      lotId,
      openingBalanceCents: 0,
      openingBeforeDay: null,
      entries: [],
      balanceCents: 0,
    };
    byLot.set(lotId, created);
    return created;
  };

  for (const opening of openings)
    lotOf(opening.lot_id).openingBalanceCents = opening.opening_cents ?? 0;

  for (const row of rows) {
    const lot = lotOf(row.lot_id);
    if (lot.openingBeforeDay === null) lot.openingBeforeDay = row.effective_day;
    lot.entries.push(toMemberEntry(row));
  }

  for (const lot of byLot.values()) {
    // A Lot whose every entry predates the reader is still THEIR Lot and still
    // has a balance; it simply has no itemized line to be "before".
    if (lot.entries.length === 0) lot.openingBeforeDay = null;
    lot.balanceCents =
      lot.openingBalanceCents +
      lot.entries.reduce((sum, e) => sum + e.amountCents, 0);
  }

  return [...byLot.values()].sort((a, b) => a.lotId.localeCompare(b.lotId));
}

/**
 * The whole ledger for one Lot, or for the association — board-only, including
 * the board-only `reference` and every provider-sourced row. Unscoped by
 * construction, so it is reachable only from a `requireBoard`-gated route.
 */
export async function fetchAdminDuesLedger(
  env: Env,
  lotId?: string,
): Promise<AdminDuesEntry[]> {
  const statement = env.DATABASE.prepare(
    `SELECT ${LEDGER_COLUMNS}, reference, source, payment_id, reverses_entry_id,
            recorded_by, recorded_at, operation_key
       FROM dues_ledger_entries
       ${lotId === undefined ? '' : 'WHERE lot_id = ?'}
      ORDER BY effective_day ASC, recorded_at ASC`,
  );
  const { results } = await (
    lotId === undefined ? statement : statement.bind(lotId)
  ).all<
    LedgerRow & {
      reference: string | null;
      source: DuesEntrySource;
      payment_id: string | null;
      reverses_entry_id: string | null;
      recorded_by: string | null;
      recorded_at: number;
      operation_key: string;
    }
  >();
  return results.map((r) => ({
    ...toMemberEntry(r),
    reference: r.reference,
    source: r.source,
    paymentId: r.payment_id,
    reversesEntryId: r.reverses_entry_id,
    recordedBy: r.recorded_by,
    recordedAt: new Date(r.recorded_at),
    operationKey: r.operation_key,
  }));
}
