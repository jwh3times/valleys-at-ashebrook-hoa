/**
 * ADR 0022 database invariants — the shared source of truth for what an
 * invariant IS.
 *
 * Two callers run these checks and must never disagree about the set:
 *
 * - `scripts/verify-invariants.ts` (`npm run verify:invariants`), the operator
 *   gate, which reaches local or remote D1 by spawning Wrangler.
 * - `src/worker.ts`'s scheduled handler, the daily drift check, which reaches
 *   production D1 through the `DATABASE` binding.
 *
 * They cannot share an execution path — a Worker cannot spawn a subprocess —
 * so they share the queries instead, the same shared-source discipline
 * `shadow-compare.ts` was built with (#240, per #206: "the checks that gate a
 * migration are exactly the checks that catch drift afterwards").
 *
 * Every check is a query that MUST return zero rows. Adding a check means
 * adding a query whose result set is "the things that are wrong".
 *
 * Rows returned by these queries are read by operators and land in Wrangler
 * output and Workers Logs, so every check selects IDs and codes only, never a
 * personal value. That is a property of each query, not of the runner; keep it
 * when adding one.
 */

export interface Check {
  name: string;
  /** What a returned row means, for the operator reading a red run. */
  meaning: string;
  sql: string;
  /** Set when a check cannot run until a later phase creates its view. */
  pendingPhase?: number;
}

/** Violating rows logged per check before truncation. Shared so the CLI gate
 * and the scheduled job report a violation at the same depth. */
export const VIOLATION_SAMPLE_LIMIT = 10;

/**
 * Overlap for inclusive-start / exclusive-end intervals, where a NULL start
 * reads as negative infinity (accepted legacy history) and a NULL end as open.
 */
function overlapPredicate(alias: string, other: string, end: string): string {
  return `(${alias}.start_day IS NULL OR ${other}.${end} IS NULL OR ${alias}.start_day < ${other}.${end})
      AND (${other}.start_day IS NULL OR ${alias}.${end} IS NULL OR ${other}.start_day < ${alias}.${end})`;
}

function intervalCheck(
  name: string,
  table: string,
  keyColumns: string[],
  end = 'end_day',
  live = `a.voided_at IS NULL AND b.voided_at IS NULL`,
): Check {
  const keys = keyColumns.map((c) => `a.${c} = b.${c}`).join(' AND ');
  return {
    name,
    meaning: `two overlapping ${table} rows share ${keyColumns.join(' + ')}`,
    sql: `SELECT a.id AS a_id, b.id AS b_id FROM ${table} a
          JOIN ${table} b ON ${keys} AND a.id < b.id
          WHERE ${live} AND ${overlapPredicate('a', 'b', end)}`,
  };
}

export const INVARIANT_CHECKS: Check[] = [
  {
    name: 'foreign_keys',
    meaning: 'a row references a parent that does not exist',
    sql: 'PRAGMA foreign_key_check',
  },

  // Interval non-overlap. These are transactional invariants at the mutation
  // boundary — a partial index cannot express interval overlap, and board
  // terms have a mandatory scheduled end so there is no `end IS NULL`
  // predicate to index at all. This is the backstop that proves the
  // transactional checks held.
  intervalCheck('ownership_overlap', 'ownerships', [
    'owner_party_id',
    'lot_id',
  ]),
  intervalCheck('representation_overlap', 'representations', [
    'representative_person_id',
    'organization_party_id',
  ]),
  intervalCheck('office_person_overlap', 'board_office_assignments', [
    'person_id',
  ]),
  intervalCheck('office_holder_overlap', 'board_office_assignments', [
    'office',
  ]),
  {
    name: 'board_term_person_overlap',
    meaning: 'one Person holds two overlapping Board Terms',
    sql: `SELECT a.id AS a_id, b.id AS b_id FROM board_service_terms a
          JOIN board_service_terms b ON a.person_id = b.person_id AND a.id < b.id
          WHERE a.voided_at IS NULL AND b.voided_at IS NULL
            AND a.cancelled_at IS NULL AND b.cancelled_at IS NULL
            AND a.start_day < COALESCE(b.actual_end_day, b.scheduled_end_day)
            AND b.start_day < COALESCE(a.actual_end_day, a.scheduled_end_day)`,
  },
  {
    name: 'board_term_lot_overlap',
    meaning: 'one Lot qualifies two overlapping Board Terms',
    sql: `SELECT a.id AS a_id, b.id AS b_id FROM board_service_terms a
          JOIN board_service_terms b ON a.qualifying_lot_id = b.qualifying_lot_id AND a.id < b.id
          WHERE a.voided_at IS NULL AND b.voided_at IS NULL
            AND a.cancelled_at IS NULL AND b.cancelled_at IS NULL
            AND a.start_day < COALESCE(b.actual_end_day, b.scheduled_end_day)
            AND b.start_day < COALESCE(a.actual_end_day, a.scheduled_end_day)`,
  },

  // Party subtype completeness. SQLite enforces child-to-parent through the
  // composite (id, kind) FK; the parent-to-child direction — every Party has
  // exactly one subtype row — is unenforceable in schema, so it is checked
  // here and written in one D1 batch.
  {
    name: 'party_subtype_completeness',
    meaning: 'a Party has no subtype row, or rows in both subtypes',
    sql: `SELECT p.id, p.kind FROM parties p
          LEFT JOIN people pe ON pe.party_id = p.id
          LEFT JOIN organizations o ON o.party_id = p.id
          WHERE (pe.party_id IS NULL AND o.party_id IS NULL)
             OR (pe.party_id IS NOT NULL AND o.party_id IS NOT NULL)`,
  },
  {
    name: 'party_consolidation_same_kind',
    meaning: 'a Party is consolidated into a Party of a different kind',
    sql: `SELECT a.id, a.kind, b.kind AS target_kind FROM parties a
          JOIN parties b ON a.consolidated_into_party_id = b.id
          WHERE a.kind <> b.kind`,
  },
  {
    name: 'party_consolidation_one_hop',
    meaning: 'a consolidation chain is longer than one hop',
    sql: `SELECT a.id FROM parties a
          JOIN parties b ON a.consolidated_into_party_id = b.id
          WHERE b.consolidated_into_party_id IS NOT NULL`,
  },

  // Ledger integrity. Every envelope has exactly one typed detail; the writers
  // enforce this in atomic batches, and this proves they did.
  {
    name: 'audit_event_detail_cardinality',
    meaning: 'an Audit Event has no typed detail, or more than one',
    sql: `SELECT e.id, e.family,
                 (SELECT COUNT(*) FROM roster_changes d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM board_service_changes d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM identity_events d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM access_events d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM roster_redactions d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM review_events d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM audit_record_corrections d WHERE d.event_id = e.id)
                 AS detail_count
          FROM audit_events e
          WHERE detail_count <> 1`,
  },
  {
    name: 'audit_causal_order',
    meaning:
      'an event is caused by a later event, or by one in another correlation',
    sql: `SELECT e.id FROM audit_events e
          JOIN audit_events c ON e.causing_event_id = c.id
          WHERE c.correlation_id <> e.correlation_id
             OR c.correlation_sequence >= e.correlation_sequence`,
  },
  {
    name: 'redaction_has_evidence_and_tasks',
    meaning: 'a redaction event has no evidence row, or no cleanup task',
    sql: `SELECT e.id FROM audit_events e
          WHERE e.family = 'roster_redaction'
            AND (NOT EXISTS (SELECT 1 FROM roster_redactions r WHERE r.event_id = e.id)
              OR NOT EXISTS (SELECT 1 FROM redaction_tasks t WHERE t.redaction_event_id = e.id))`,
  },
  {
    name: 'review_flag_has_opening_event',
    meaning: 'a Review Flag has no opening Review Event',
    sql: `SELECT f.id FROM review_flags f
          WHERE NOT EXISTS (SELECT 1 FROM review_events v WHERE v.review_flag_id = f.id)`,
  },

  // Ballot secrecy. Impact discovery is exactly the feature that would find
  // joining choices to owners convenient, so the prohibition is checked rather
  // than merely documented.
  {
    name: 'no_flag_references_ballot_choices',
    meaning: 'a Review Flag column references ballot_choices',
    sql: `SELECT name FROM pragma_table_info('review_flags')
          WHERE name LIKE '%choice%' OR name LIKE '%candidate%'`,
  },

  // View-backed checks, live since phase 2 created the views. These overlap
  // some of the direct queries above on purpose: the direct ones prove the
  // condition, the views prove the SHAPE the application will read is the same
  // shape the gate checks. A view that drifts from its check is exactly how a
  // green dashboard ends up disagreeing with a red gate.
  {
    name: 'audit_integrity_violations',
    meaning: 'the audit integrity view reported a violation',
    sql: 'SELECT * FROM audit_integrity_violations_v',
  },
  {
    name: 'board_eligibility_violations',
    meaning:
      'a Board Term outlived the Ownership or Representation qualifying it',
    sql: 'SELECT * FROM board_eligibility_violations_v',
  },
];

/** One check's outcome. `pending` and `errored` are deliberately distinct from
 * `ok`: a check that could not run has proven nothing, and must never be
 * counted as green — zero rows is this gate's GREEN, and a failed query
 * returns zero rows too. */
export interface CheckResult {
  name: string;
  meaning: string;
  status: 'ok' | 'violated' | 'errored' | 'pending';
  /** Violating rows, capped at VIOLATION_SAMPLE_LIMIT. IDs and codes only. */
  sample?: unknown[];
  rowCount?: number;
  error?: string;
}

export interface InvariantRun {
  results: CheckResult[];
  /** Checks that actually executed — pending ones are excluded. */
  ran: number;
  pending: number;
  violated: number;
  errored: number;
  /** True when every check that could run returned zero rows. */
  healthy: boolean;
}

/**
 * Run every invariant through a D1 binding.
 *
 * Sequential rather than concurrent on purpose: this is a daily background job
 * with no latency budget, and `PRAGMA foreign_key_check` walks every table.
 * Racing seventeen scans against the production database to save a few seconds
 * of cron time is the wrong trade.
 *
 * Never throws for a violation or a broken query — it reports them. Deciding
 * what a red run means belongs to the caller: the CLI gate exits non-zero, and
 * the scheduled handler throws so the invocation registers as failed.
 */
export async function runInvariants(env: Env): Promise<InvariantRun> {
  const results: CheckResult[] = [];

  for (const check of INVARIANT_CHECKS) {
    if (check.pendingPhase) {
      results.push({
        name: check.name,
        meaning: check.meaning,
        status: 'pending',
      });
      continue;
    }
    try {
      const { results: rows } = await env.DATABASE.prepare(check.sql).all();
      results.push(
        rows.length === 0
          ? { name: check.name, meaning: check.meaning, status: 'ok' }
          : {
              name: check.name,
              meaning: check.meaning,
              status: 'violated',
              rowCount: rows.length,
              sample: rows.slice(0, VIOLATION_SAMPLE_LIMIT),
            },
      );
    } catch (err) {
      results.push({
        name: check.name,
        meaning: check.meaning,
        status: 'errored',
        error: String(err instanceof Error ? err.message : err),
      });
    }
  }

  const violated = results.filter((r) => r.status === 'violated').length;
  const errored = results.filter((r) => r.status === 'errored').length;
  const pending = results.filter((r) => r.status === 'pending').length;

  return {
    results,
    ran: results.length - pending,
    pending,
    violated,
    errored,
    healthy: violated === 0 && errored === 0,
  };
}

/**
 * One log line per problem, plus a summary line. Returned rather than logged so
 * the caller owns the log channel and the lines stay assertable in a test.
 *
 * Carries IDs and codes only — see this module's header. Do not add a check
 * whose rows would break that, and do not widen this formatter to compensate.
 */
export function formatInvariantRun(run: InvariantRun): string[] {
  const lines: string[] = [];

  for (const result of run.results) {
    if (result.status === 'violated') {
      lines.push(
        `[invariants] VIOLATED ${result.name} — ${result.rowCount} row(s): ${result.meaning}`,
      );
      for (const row of result.sample ?? [])
        lines.push(`[invariants]   ${JSON.stringify(row)}`);
      if ((result.rowCount ?? 0) > VIOLATION_SAMPLE_LIMIT)
        lines.push(
          `[invariants]   … ${(result.rowCount ?? 0) - VIOLATION_SAMPLE_LIMIT} more`,
        );
    } else if (result.status === 'errored') {
      lines.push(
        `[invariants] ERRORED ${result.name} — query failed: ${result.error}`,
      );
    }
  }

  lines.push(
    `[invariants] ${run.ran} checks run, ${run.pending} pending, ${run.violated} violated, ${run.errored} errored`,
  );
  return lines;
}
