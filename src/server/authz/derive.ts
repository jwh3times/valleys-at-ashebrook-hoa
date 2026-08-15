import type { Role } from './guards';

// ADR 0022 derived authorization (issue #210, phase 2).
//
// PHASE 2: this is computed in SHADOW MODE and compared against the legacy
// context. It never affects a response. Legacy decides every request until the
// phase-3 flip.
//
// Three rules this module exists to enforce, each of which the old rank ladder
// broke:
//
//  1. NOTHING IS CACHED. Not in the session, not in a read model. A revoked
//     System Administrator must lose access on their next request, not at
//     session expiry, and a backdated Ownership must take effect when recorded.
//     Any cache reintroduces a staleness window on exactly the security-
//     critical path.
//
//  2. THE LADDER IS GONE. `board >= homeowner` is why a board member who owns
//     no Lot currently passes the member-only gate for free. A System
//     Administrator need not be an Owner at all, so ordering the levels would
//     hand them Lot Authority with no association basis.
//
//  3. EVALUATION NEVER TRUSTS THE WRITE PATH. A stored Board grant is
//     re-validated against its qualifying term on every request. The mutation
//     boundary should already have ended it; this is the mirror of the repo's
//     existing discipline of re-checking inside mutation SQL.
//
// The last-System-Administrator invariant is deliberately ABSENT and must stay
// absent: evaluation asks only whether this caller holds the grant, never how
// many administrators exist. Counting per request would make an authorization
// decision depend on global mutable state.

/** Capability levels. Deliberately a SET, not a ladder — `systemAdmin` implies
 * every `board` capability, but neither implies `member`, which comes only from
 * Ownership or Representation. The last four are the System-Administrator-only
 * technical capabilities (#205): granted with `systemAdmin`, never separately.
 * (Duplicated from guards.ts so the offline sweep can import this module
 * without the guard layer; keep the two unions identical.) */
export type Capability =
  | 'member'
  | 'board'
  | 'systemAdmin'
  | 'redactionAuthorize'
  | 'redactionCleanup'
  | 'accessDenialDetail'
  | 'auditIntegrityViews';

export interface DerivedAccess {
  userId: string;
  /** The linked Person, or null. No current Person Link means visitor, full
   * stop — regardless of what Ownerships the underlying Person may hold. */
  personId: string | null;
  capabilities: Set<Capability>;
  /** Lots this caller may act for: their Current Ownerships, plus Lots covered
   * by their current Representations. */
  lotIds: string[];
  /** Content sensitivity, a separate question from what the caller may DO. */
  contentTier: Role;
  /** Distinct from holding Board Access: a scheduled-term holder may read the
   * admin surfaces but may not approve identity or representation facts, which
   * `CONTEXT.md` restricts to a *current* Board Member with Board Access. */
  hasCurrentBoardTerm: boolean;
  /**
   * A live Board grant whose qualifying term no longer supports it, or null.
   *
   * Evaluation already refused it — that is rule 3 above, and the refusal is
   * complete without this field. It carries the id out because the survival of
   * the grant is an integrity signal about the WRITE path (the mutation
   * boundary should have ended it), not an ordinary denial about the caller.
   *
   * Recorded as a day-idempotent Access Event attributed to the denied caller
   * (#217's option 1, implemented in 3b): see `revalidation-event.ts`, called
   * from `context.ts` only when derived is the SERVING model — the shadow
   * layer computes this field too and must never write.
   *
   * Named independently of `capabilities` on purpose. A caller holding two
   * Board grants, one valid and one stale, is not denied — but the stale one is
   * still worth recording, and folding this into "has_board = 0" would lose it.
   */
  invalidBoardGrantId: string | null;
}

/**
 * One statement, evaluated at the request's Association Day.
 *
 * `system_admin` needs no precondition beyond a live grant. `board` re-checks
 * that its qualifying term is still current-or-scheduled, uncancelled and
 * unvoided — a term whose end day has passed no longer supports the grant even
 * if the mutation boundary failed to end it.
 *
 * `has_current_board_term` deliberately ignores grants: it is a fact about
 * service, not about access.
 */
export const CAPABILITY_SQL = `
  SELECT
    pl.person_id AS person_id,
    EXISTS (
      SELECT 1 FROM access_grants g
      WHERE g.account_id = ?1
        AND g.grant_type = 'system_admin'
        AND g.ended_at IS NULL
    ) AS has_system_admin,
    EXISTS (
      SELECT 1 FROM access_grants g
      JOIN board_service_terms t ON t.id = g.qualifying_board_term_id
      WHERE g.account_id = ?1
        AND g.grant_type = 'board'
        AND g.ended_at IS NULL
        AND t.voided_at IS NULL
        AND t.cancelled_at IS NULL
        AND ?2 < COALESCE(t.actual_end_day, t.scheduled_end_day)
    ) AS has_board,
    EXISTS (
      SELECT 1 FROM board_service_terms t
      WHERE t.person_id = pl.person_id
        AND t.voided_at IS NULL
        AND t.cancelled_at IS NULL
        AND t.start_day <= ?2
        AND ?2 < COALESCE(t.actual_end_day, t.scheduled_end_day)
    ) AS has_current_board_term,
    (
      SELECT g.id FROM access_grants g
      LEFT JOIN board_service_terms t ON t.id = g.qualifying_board_term_id
      WHERE g.account_id = ?1
        AND g.grant_type = 'board'
        AND g.ended_at IS NULL
        AND NOT (
          t.id IS NOT NULL
          AND t.voided_at IS NULL
          AND t.cancelled_at IS NULL
          AND ?2 < COALESCE(t.actual_end_day, t.scheduled_end_day)
        )
      LIMIT 1
    ) AS invalid_board_grant_id
  FROM person_links pl
  WHERE pl.account_id = ?1 AND pl.ended_at IS NULL
`;

/**
 * The caller's Lots.
 *
 * `me` canonicalizes a consolidated duplicate one hop, so a Party that was
 * merged into a survivor resolves to the survivor's authority.
 *
 * The two branches are the whole Representation model in SQL. Organization-wide
 * scope resolves BY JOIN to whatever the Organization currently owns — so a Lot
 * the entity buys later is covered with no roster edit. Lot-scoped rows are
 * intersected with that same Current Ownership, so a scoped Lot the entity has
 * since sold grants nothing.
 *
 * Retired Lots are excluded. `properties.status` is deliberately not consulted:
 * it remains the legacy field, and `retired_at` is the new model's answer.
 */
export const LOT_SQL = `
  WITH me AS (
    SELECT COALESCE(pa.consolidated_into_party_id, pa.id) AS party_id
    FROM person_links pl
    JOIN parties pa ON pa.id = pl.person_id
    WHERE pl.account_id = ?1 AND pl.ended_at IS NULL
  )
  SELECT DISTINCT x.lot_id AS lot_id
  FROM (
    SELECT o.lot_id
    FROM ownerships o
    JOIN me ON o.owner_party_id = me.party_id
    WHERE o.voided_at IS NULL
      AND (o.start_day IS NULL OR o.start_day <= ?2)
      AND (o.end_day IS NULL OR ?2 < o.end_day)
    UNION
    SELECT o2.lot_id
    FROM representations r
    JOIN me ON r.representative_person_id = me.party_id
    JOIN ownerships o2
      ON o2.owner_party_id = r.organization_party_id
     AND o2.voided_at IS NULL
     AND (o2.start_day IS NULL OR o2.start_day <= ?2)
     AND (o2.end_day IS NULL OR ?2 < o2.end_day)
    WHERE r.voided_at IS NULL
      AND r.start_day <= ?2
      AND (r.end_day IS NULL OR ?2 < r.end_day)
      AND (
        r.scope_kind = 'organization'
        OR EXISTS (
          SELECT 1 FROM representation_lots rl
          WHERE rl.representation_id = r.id
            AND rl.lot_id = o2.lot_id
            AND rl.voided_at IS NULL
        )
      )
  ) x
  JOIN properties p ON p.id = x.lot_id
  WHERE p.retired_at IS NULL
`;

export interface CapabilityRow {
  person_id: string;
  has_system_admin: number;
  has_board: number;
  has_current_board_term: number;
  invalid_board_grant_id: string | null;
}

/**
 * Derives one caller's access from current facts.
 *
 * Two D1 statements in ONE batch — one round trip, matching what the legacy
 * context already costs. Raw D1 rather than Drizzle here on purpose: `batch`
 * is what makes it a single round trip, and Drizzle's builder cannot carry
 * these recursive-CTE and EXISTS shapes into one.
 *
 * `associationDay` is an explicit parameter, never read from `locals` or
 * computed here, so a guard can never be spoofed by whatever a caller managed
 * to put on the request. `date('now')` is banned from authorization SQL.
 *
 * A thrown error propagates. It must never be caught into a visitor context: a
 * transient D1 failure presenting a linked board member as anonymous would look
 * exactly like a permissions bug.
 */
export async function deriveAccess(
  env: Env,
  accountId: string,
  associationDay: string,
): Promise<DerivedAccess> {
  const [capabilityResult, lotResult] = await env.DATABASE.batch([
    env.DATABASE.prepare(CAPABILITY_SQL).bind(accountId, associationDay),
    env.DATABASE.prepare(LOT_SQL).bind(accountId, associationDay),
  ]);

  return toDerivedAccess(
    accountId,
    (capabilityResult.results as CapabilityRow[])[0],
    (lotResult.results as { lot_id: string }[]).map((r) => r.lot_id),
  );
}

/**
 * Turns the two query results into a context.
 *
 * Exported and pure so the OFFLINE SWEEP produces the same answer as a live
 * request. The sweep runs outside the Worker and cannot call `deriveAccess`, so
 * it reuses `CAPABILITY_SQL`, `LOT_SQL`, and this mapper instead of
 * reimplementing them — a sweep with its own copy would be testing the copy,
 * and would miss exactly the derivation bug it exists to catch.
 */
export function toDerivedAccess(
  accountId: string,
  row: CapabilityRow | undefined,
  lotIds: string[],
): DerivedAccess {
  // No current Person Link means visitor. Not "member with no lots" — visitor.
  if (!row) {
    return {
      userId: accountId,
      personId: null,
      capabilities: new Set(),
      lotIds: [],
      contentTier: 'visitor',
      hasCurrentBoardTerm: false,
      invalidBoardGrantId: null,
    };
  }

  const capabilities = new Set<Capability>();
  // Member Access is derived and has no stored row: it exists exactly when the
  // linked Person holds at least one Lot through Ownership or Representation.
  if (lotIds.length > 0) capabilities.add('member');
  if (row.has_board === 1) capabilities.add('board');
  if (row.has_system_admin === 1) {
    capabilities.add('systemAdmin');
    // Implied, not a duplicate grant.
    capabilities.add('board');
    // The four technical capabilities travel with the grant as a unit — they
    // are names for the System-Administrator boundary, not separate grants.
    capabilities.add('redactionAuthorize');
    capabilities.add('redactionCleanup');
    capabilities.add('accessDenialDetail');
    capabilities.add('auditIntegrityViews');
  }

  // Content sensitivity is a separate axis from capability. `tierAllows`,
  // `visibleTiers`, and every call site stay untouched — this is the same
  // freeze-the-shape-swap-the-source move the cutover relies on.
  const contentTier: Role = capabilities.has('board')
    ? 'board'
    : capabilities.has('member')
      ? 'homeowner'
      : 'visitor';

  return {
    userId: accountId,
    personId: row.person_id,
    capabilities,
    lotIds,
    contentTier,
    hasCurrentBoardTerm: row.has_current_board_term === 1,
    invalidBoardGrantId: row.invalid_board_grant_id ?? null,
  };
}
