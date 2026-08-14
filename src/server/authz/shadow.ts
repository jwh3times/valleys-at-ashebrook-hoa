import type { AuthContext } from './guards';
import { deriveAccess } from './derive';

// ADR 0022 shadow comparison (issue #210, phase 2).
//
// Computes the derived context alongside the legacy one and records ONLY the
// disagreements. It never affects a response, and it never denies.
//
// Three properties, in order of how badly they would hurt if broken:
//
//  1. IT CANNOT CHANGE THE ANSWER. This function returns void and is called
//     after the legacy context is already resolved. Live authorization must
//     never fail closed because the shadow model failed — a derivation
//     exception here is logged and swallowed, not propagated.
//
//  2. IT WRITES IDS AND CODES ONLY. Counts, never lot identifiers; account ids,
//     never names or addresses. The table is operator-only and bounded, and it
//     is dropped in phase 4.
//
//  3. IT RECORDS MISMATCHES ONLY. A row per request would be volume nobody
//     reads; a row per disagreement is a work queue.
//
// Request-path shadowing alone is NOT sufficient evidence for the flip. On a
// 21-Lot site most accounts never sign in during a phase-2 window, so "zero
// mismatches" here could mean three accounts were exercised. The offline sweep
// over every account is what makes the gate meaningful; this proves the
// derivation works under real middleware, which the sweep cannot.

export type ShadowSource = 'request' | 'sweep';

export interface ShadowComparison {
  matched: boolean;
  legacyRole: string;
  derivedContentTier: string;
  legacyLotCount: number;
  derivedLotCount: number;
}

/**
 * Pure comparison, so the decision of what counts as a mismatch is testable
 * without a database.
 *
 * Compares the content tier and the lot SET — sorted and de-duplicated, because
 * ordering is an artifact of the query plan and would otherwise report a
 * mismatch that does not exist.
 */
export function compareContexts(
  legacy: Pick<AuthContext, 'role' | 'propertyIds'>,
  derived: { contentTier: string; lotIds: string[] },
): ShadowComparison {
  const legacyLots = [...new Set(legacy.propertyIds)].sort();
  const derivedLots = [...new Set(derived.lotIds)].sort();
  return {
    matched:
      legacy.role === derived.contentTier &&
      legacyLots.length === derivedLots.length &&
      legacyLots.every((id, i) => id === derivedLots[i]),
    legacyRole: legacy.role,
    derivedContentTier: derived.contentTier,
    legacyLotCount: legacyLots.length,
    derivedLotCount: derivedLots.length,
  };
}

const RECORD_SQL = `
  INSERT INTO cutover_shadow_mismatches
    (id, account_id, source, legacy_role, derived_content_tier,
     legacy_lot_count, derived_lot_count, first_seen_at, last_seen_at, seen_count)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 1)
  ON CONFLICT (id) DO UPDATE SET
    legacy_role = excluded.legacy_role,
    derived_content_tier = excluded.derived_content_tier,
    legacy_lot_count = excluded.legacy_lot_count,
    derived_lot_count = excluded.derived_lot_count,
    last_seen_at = excluded.last_seen_at,
    seen_count = seen_count + 1
`;

/**
 * Records one disagreement, collapsing repeats onto a single row per account
 * and source so a caller hitting the site all day does not flood the table.
 *
 * `explained_as` is left NULL deliberately. An operator classifies a row
 * against the pre-agreed allow-list; a NULL is an UNEXPLAINED mismatch, and any
 * unexplained mismatch blocks the flip. Nothing here may classify its own
 * mismatch — that would let the code decide its own gate.
 */
export async function recordMismatch(
  env: Env,
  accountId: string,
  source: ShadowSource,
  comparison: ShadowComparison,
  now: number,
): Promise<void> {
  await env.DATABASE.prepare(RECORD_SQL)
    .bind(
      `${source}:${accountId}`,
      accountId,
      source,
      comparison.legacyRole,
      comparison.derivedContentTier,
      comparison.legacyLotCount,
      comparison.derivedLotCount,
      now,
    )
    .run();
}

/**
 * The request-path entry point. Returns nothing and throws nothing.
 *
 * Awaited rather than fired into `waitUntil`: it costs one D1 batch, this is a
 * low-traffic site, and a cancelled background write would lose exactly the
 * evidence the flip gate depends on. Both the cost and the call disappear at
 * the phase-3 flip.
 */
export async function compareInShadow(
  env: Env,
  legacy: AuthContext,
  associationDay: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const derived = await deriveAccess(env, legacy.userId, associationDay);
    const comparison = compareContexts(legacy, derived);
    if (comparison.matched) return;
    await recordMismatch(env, legacy.userId, 'request', comparison, now);
  } catch (error) {
    // Deliberately swallowed. The shadow model failing must never deny a
    // request that legacy already allowed.
    console.error('shadow comparison failed', {
      accountId: legacy.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
