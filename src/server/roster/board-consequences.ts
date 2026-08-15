// Substitute-or-terminate: the mutation-boundary consequence engine for Board
// Terms whose qualifying basis an Ownership or Representation change removes
// (#202, #203, built in 3b #218).
//
// The rules, from #203's resolution:
//
//  - The ending command accepts an optional per-affected-term substitute
//    qualifying Lot, validated as one the Person currently owns or represents.
//    Absent it, the Term ends automatically as a caused Board Service Change,
//    along with its Office Assignments and its Board Access grant.
//  - A backdated loss splits the two days deliberately: the TERM ends on the
//    real-world day the basis ended, while the GRANT ends at Recorded At, now
//    — grant instants cannot be backdated, and access already exercised cannot
//    be retroactively un-exercised. The Review Flags for actions inside that
//    window belong to phase 3d (#220), not here.
//  - A term that had not yet started is CANCELLED, not ended — no service ever
//    occurred. A term that started inside the phantom window (its start day is
//    on or after the backdated loss) is cancelled too: `actual_end_day` must
//    exceed `start_day`, and a cancellation is the legal shape that says "this
//    service never validly ran".
//
// Qualification is evaluated at the request's Association Day against the
// POST-UPDATE world: the command's own domain statement has already ended the
// row inside the same batch transaction, so the ordinary currency predicate
// excludes it with no special-case binds — and a person who still qualifies
// through another current basis (a second Lot's co-ownership, an
// organization-wide Representation) keeps the term untouched.

import {
  AuditCorrelation,
  andGuards,
  type SqlGuard,
} from './audit';

/**
 * The one qualification predicate, shared by this engine, `createTerm`,
 * `substituteQualifyingLot`, election `certify`, and Lot retirement's refusal
 * — and deliberately the same shape as `board_eligibility_violations_v`
 * (migration 0025), so the integrity view can only report what the mutation
 * boundary genuinely failed to enforce.
 */
export function qualifiesGuard(
  personId: string,
  lotId: string,
  associationDay: string,
): SqlGuard {
  return {
    sql: `(
      EXISTS (
        SELECT 1 FROM ownerships o
        WHERE o.owner_party_id = ? AND o.lot_id = ? AND o.voided_at IS NULL
          AND (o.start_day IS NULL OR o.start_day <= ?)
          AND (o.end_day IS NULL OR ? < o.end_day)
      )
      OR EXISTS (
        SELECT 1 FROM representations r
        JOIN ownerships o2 ON o2.owner_party_id = r.organization_party_id
          AND o2.lot_id = ?
          AND o2.voided_at IS NULL
          AND (o2.start_day IS NULL OR o2.start_day <= ?)
          AND (o2.end_day IS NULL OR ? < o2.end_day)
        WHERE r.representative_person_id = ? AND r.voided_at IS NULL
          AND r.start_day <= ?
          AND (r.end_day IS NULL OR ? < r.end_day)
          AND (
            r.scope_kind = 'organization'
            OR EXISTS (
              SELECT 1 FROM representation_lots rl
              WHERE rl.representation_id = r.id AND rl.lot_id = ?
                AND rl.voided_at IS NULL
            )
          )
      )
    )`,
    binds: [
      personId,
      lotId,
      associationDay,
      associationDay,
      lotId,
      associationDay,
      associationDay,
      personId,
      associationDay,
      associationDay,
      lotId,
    ],
  };
}

/** No live term of another shape overlaps `[startDay, endDay)` for this
 * person / this qualifying lot. Interval overlap cannot live in an index
 * (#203), so every writer carries this as conditional SQL. */
export function noOverlapGuard(
  column: 'person_id' | 'qualifying_lot_id',
  id: string,
  startDay: string,
  endDay: string,
  excludeTermId?: string,
): SqlGuard {
  return {
    sql: `NOT EXISTS (
      SELECT 1 FROM board_service_terms x
      WHERE x.${column} = ? AND x.cancelled_at IS NULL AND x.voided_at IS NULL
        AND x.start_day < ? AND ? < COALESCE(x.actual_end_day, x.scheduled_end_day)
        ${excludeTermId ? 'AND x.id <> ?' : ''}
    )`,
    binds: [id, endDay, startDay, ...(excludeTermId ? [excludeTermId] : [])],
  };
}

interface AffectedTerm {
  id: string;
  person_id: string;
  qualifying_lot_id: string;
  start_day: string;
  scheduled_end_day: string;
  offices: { id: string; start_day: string }[];
  grants: { id: string; account_id: string }[];
}

export interface LossConsequenceInput {
  database: D1Database;
  nowMs: number;
  /** Qualification is re-evaluated here (today). */
  associationDay: string;
  /** The real-world day the basis ended — the term's end day, possibly
   * backdated. For a void, the recording day: the basis never existed, but
   * service factually ran until the error was found. */
  effectiveDay: string;
  /** Lots whose authority the command may have removed. */
  lots: string[];
  /** The command's success marker: consequences land only if the primary
   * domain write did. */
  rootGuard: SqlGuard;
  /** Per-term substitute qualifying Lots supplied in the command. */
  substitutions: ReadonlyMap<string, string>;
  /** `automatic_cause` label for caused ledger events. */
  cause: string;
  correlation: AuditCorrelation;
  /** The commanding account, stamped as `ended_by` on caused grant ends. */
  actorAccountId: string;
}

export interface LossConsequences {
  /** Domain statements, to run after the command's primary statements and
   * before the correlation's ledger statements. */
  statements: D1PreparedStatement[];
  /** Terms the pre-batch read found affected (before in-batch re-check). */
  affectedTermIds: string[];
  /** Guards that must hold after the batch or the route must roll it back —
   * one per substitution, proving the substitute landed. */
  substitutionAsserts: SqlGuard[];
}

/**
 * Enumerates live terms whose qualifying Lot is among `lots` and whose person
 * would no longer qualify once the command lands, then builds the caused
 * updates and ledger events. The enumeration is a pre-batch read; every
 * statement re-checks its own precondition inside the batch, so a term whose
 * basis was concurrently restored (or already ended) simply no-ops.
 */
export async function lossConsequences(
  input: LossConsequenceInput,
): Promise<LossConsequences> {
  if (input.lots.length === 0)
    return { statements: [], affectedTermIds: [], substitutionAsserts: [] };

  const placeholders = input.lots.map(() => '?').join(', ');
  const candidates = await input.database
    .prepare(
      `SELECT t.id, t.person_id, t.qualifying_lot_id, t.start_day, t.scheduled_end_day
       FROM board_service_terms t
       WHERE t.qualifying_lot_id IN (${placeholders})
         AND t.actual_end_day IS NULL AND t.cancelled_at IS NULL AND t.voided_at IS NULL
         AND ? < t.scheduled_end_day`,
    )
    .bind(...input.lots, input.associationDay)
    .all<{
      id: string;
      person_id: string;
      qualifying_lot_id: string;
      start_day: string;
      scheduled_end_day: string;
    }>();

  const affected: AffectedTerm[] = [];
  for (const t of candidates.results) {
    const [offices, grants] = await input.database.batch([
      input.database
        .prepare(
          `SELECT id, start_day FROM board_office_assignments
           WHERE board_term_id = ? AND end_day IS NULL AND voided_at IS NULL`,
        )
        .bind(t.id),
      input.database
        .prepare(
          `SELECT id, account_id FROM access_grants
           WHERE qualifying_board_term_id = ? AND grant_type = 'board' AND ended_at IS NULL`,
        )
        .bind(t.id),
    ]);
    affected.push({
      ...t,
      offices: offices.results as { id: string; start_day: string }[],
      grants: grants.results as { id: string; account_id: string }[],
    });
  }

  const statements: D1PreparedStatement[] = [];
  const substitutionAsserts: SqlGuard[] = [];

  for (const term of affected) {
    const substitute = input.substitutions.get(term.id);
    const stillQualifies = qualifiesGuard(
      term.person_id,
      term.qualifying_lot_id,
      input.associationDay,
    );
    const noLongerQualifies: SqlGuard = {
      sql: `NOT ${stillQualifies.sql}`,
      binds: stillQualifies.binds,
    };

    if (substitute) {
      // In-place substitution: service is continuous (#203). Validated at the
      // mutation boundary: the person qualifies through the NEW lot in the
      // post-update world, and no live term already occupies that lot.
      const canSubstitute = andGuards(
        input.rootGuard,
        qualifiesGuard(term.person_id, substitute, input.associationDay),
        noOverlapGuard(
          'qualifying_lot_id',
          substitute,
          term.start_day,
          term.scheduled_end_day,
          term.id,
        ),
      );
      statements.push(
        input.database
          .prepare(
            `UPDATE board_service_terms SET qualifying_lot_id = ?, updated_at = ?
             WHERE id = ? AND actual_end_day IS NULL AND cancelled_at IS NULL AND voided_at IS NULL
               AND (${canSubstitute.sql})`,
          )
          .bind(substitute, input.nowMs, term.id, ...canSubstitute.binds),
      );
      const landed: SqlGuard = {
        sql: `EXISTS (SELECT 1 FROM board_service_terms WHERE id = ? AND qualifying_lot_id = ? AND updated_at = ?)`,
        binds: [term.id, substitute, input.nowMs],
      };
      input.correlation.event({
        kind: 'qualifying_lot_substituted',
        guard: landed,
        detail: {
          family: 'board_service_change',
          effective: { day: input.effectiveDay },
          reason: 'qualifying_lot_substituted',
          evidence: { kind: 'operator_observation' },
          subjects: [
            { column: 'board_term_id', id: term.id, role: 'primary' },
            { column: 'lot_id', id: term.qualifying_lot_id, role: 'related' },
            { column: 'lot_id', id: substitute, role: 'replacement' },
          ],
        },
      });
      // The route rolls the whole batch back if this did not land: a named
      // substitute that fails validation must fail the command, never fall
      // through to a silent termination.
      substitutionAsserts.push(landed);
      continue;
    }

    // Terminate-by-default. The end/cancel branch is decided in SQL against
    // the term's own start day: started terms end on the effective day;
    // unstarted (or phantom-window) terms are cancelled.
    const guard = andGuards(input.rootGuard, noLongerQualifies);
    statements.push(
      input.database
        .prepare(
          `UPDATE board_service_terms SET
             actual_end_day = CASE WHEN start_day < ? THEN ? ELSE NULL END,
             cancelled_day  = CASE WHEN start_day < ? THEN NULL ELSE MIN(?, date(start_day, '-1 day')) END,
             cancelled_at   = CASE WHEN start_day < ? THEN NULL ELSE ? END,
             updated_at = ?
           WHERE id = ? AND actual_end_day IS NULL AND cancelled_at IS NULL AND voided_at IS NULL
             AND (${guard.sql})`,
        )
        .bind(
          input.effectiveDay,
          input.effectiveDay,
          input.effectiveDay,
          input.effectiveDay,
          input.effectiveDay,
          input.nowMs,
          input.nowMs,
          term.id,
          ...guard.binds,
        ),
    );

    const endedMarker: SqlGuard = {
      sql: `EXISTS (SELECT 1 FROM board_service_terms WHERE id = ? AND updated_at = ? AND actual_end_day IS NOT NULL)`,
      binds: [term.id, input.nowMs],
    };
    const cancelledMarker: SqlGuard = {
      sql: `EXISTS (SELECT 1 FROM board_service_terms WHERE id = ? AND updated_at = ? AND cancelled_at IS NOT NULL)`,
      binds: [term.id, input.nowMs],
    };

    // Both events are registered; the branch guards mean exactly one (or,
    // when a concurrent command got there first, neither) inserts.
    input.correlation.event({
      kind: 'board_term_ended',
      guard: endedMarker,
      actor: { kind: 'automatic', cause: input.cause },
      detail: {
        family: 'board_service_change',
        effective: { day: input.effectiveDay },
        reason: 'eligibility_lost',
        evidence: { kind: 'operator_observation' },
        subjects: [
          { column: 'board_term_id', id: term.id, role: 'ended' },
          { column: 'lot_id', id: term.qualifying_lot_id, role: 'related' },
        ],
      },
    });
    input.correlation.event({
      kind: 'board_term_cancelled',
      guard: cancelledMarker,
      actor: { kind: 'automatic', cause: input.cause },
      detail: {
        family: 'board_service_change',
        effective: { day: input.effectiveDay },
        reason: 'eligibility_lost',
        evidence: { kind: 'operator_observation' },
        subjects: [
          { column: 'board_term_id', id: term.id, role: 'voided' },
          { column: 'lot_id', id: term.qualifying_lot_id, role: 'related' },
        ],
      },
    });

    for (const office of term.offices) {
      // An ended term ends its offices (never before they began); a cancelled
      // term voids them — an office on a term that never ran was never a fact.
      statements.push(
        input.database
          .prepare(
            `UPDATE board_office_assignments SET end_day = MAX(?, date(start_day, '+1 day')), updated_at = ?
             WHERE id = ? AND end_day IS NULL AND voided_at IS NULL AND (${endedMarker.sql})`,
          )
          .bind(input.effectiveDay, input.nowMs, office.id, ...endedMarker.binds),
      );
      statements.push(
        input.database
          .prepare(
            `UPDATE board_office_assignments SET voided_at = ?, updated_at = ?
             WHERE id = ? AND end_day IS NULL AND voided_at IS NULL AND (${cancelledMarker.sql})`,
          )
          .bind(input.nowMs, input.nowMs, office.id, ...cancelledMarker.binds),
      );
      input.correlation.event({
        kind: 'office_assignment_ended',
        guard: {
          sql: `EXISTS (SELECT 1 FROM board_office_assignments WHERE id = ? AND updated_at = ? AND end_day IS NOT NULL)`,
          binds: [office.id, input.nowMs],
        },
        actor: { kind: 'automatic', cause: input.cause },
        detail: {
          family: 'board_service_change',
          effective: { day: input.effectiveDay },
          reason: 'eligibility_lost',
          evidence: { kind: 'operator_observation' },
          subjects: [
            { column: 'office_assignment_id', id: office.id, role: 'ended' },
            { column: 'board_term_id', id: term.id, role: 'related' },
          ],
        },
      });
      input.correlation.event({
        kind: 'office_assignment_voided',
        guard: {
          sql: `EXISTS (SELECT 1 FROM board_office_assignments WHERE id = ? AND updated_at = ? AND voided_at IS NOT NULL)`,
          binds: [office.id, input.nowMs],
        },
        actor: { kind: 'automatic', cause: input.cause },
        detail: {
          family: 'board_service_change',
          effective: { day: input.effectiveDay },
          reason: 'eligibility_lost',
          evidence: { kind: 'operator_observation' },
          subjects: [
            { column: 'office_assignment_id', id: office.id, role: 'voided' },
            { column: 'board_term_id', id: term.id, role: 'related' },
          ],
        },
      });
    }

    for (const grant of term.grants) {
      // The grant ends NOW, whatever day the term ended — access cannot be
      // retroactively un-exercised (#203's effective-versus-recorded split).
      const termConcluded: SqlGuard = {
        sql: `EXISTS (SELECT 1 FROM board_service_terms WHERE id = ? AND updated_at = ? AND (actual_end_day IS NOT NULL OR cancelled_at IS NOT NULL))`,
        binds: [term.id, input.nowMs],
      };
      statements.push(
        input.database
          .prepare(
            `UPDATE access_grants SET ended_at = ?, ended_by_account_id = ?,
               end_reason = CASE WHEN EXISTS (SELECT 1 FROM board_service_terms WHERE id = ? AND cancelled_at IS NOT NULL) THEN 'term_cancelled' ELSE 'term_ended' END
             WHERE id = ? AND ended_at IS NULL AND (${termConcluded.sql})`,
          )
          .bind(
            input.nowMs,
            input.actorAccountId,
            term.id,
            grant.id,
            ...termConcluded.binds,
          ),
      );
      input.correlation.event({
        kind: 'grant_ended',
        guard: {
          sql: `EXISTS (SELECT 1 FROM access_grants WHERE id = ? AND ended_at = ?)`,
          binds: [grant.id, input.nowMs],
        },
        actor: { kind: 'automatic', cause: input.cause },
        detail: {
          family: 'access',
          grantId: grant.id,
          targetAccountId: grant.account_id,
          grantType: 'board',
          requestedAction: 'revoke',
          outcome: 'allowed',
          reason: 'eligibility_lost',
        },
      });
    }
  }

  return {
    statements,
    affectedTermIds: affected.map((t) => t.id),
    substitutionAsserts,
  };
}
