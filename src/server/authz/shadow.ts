import type { AuthContext } from './guards';
import { deriveAccess } from './derive';
import { getCutoverMode } from './cutover-mode';
import { readLegacyRosterContext } from './context';
import {
  compareContexts,
  type ShadowComparison,
  type ShadowSource,
} from './shadow-compare';

// Re-exported so callers have one import site for the shadow layer.
export { compareContexts };
export type { ShadowComparison, ShadowSource };

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

export const RECORD_SQL = `
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
 * `ctx` is whichever context SERVED the request, and the comparison is
 * mode-aware on purpose. Phase 2 built this with legacy always authoritative,
 * so it treated `ctx` as the legacy side unconditionally — which turned into a
 * self-comparison the moment `cutover_mode = derived` existed: the served
 * context was already the derived answer, so the "two models" agreed by
 * identity and the mismatch table went silently green exactly when the flip's
 * quiet period needs it watching. Now the OTHER model is computed fresh: under
 * `legacy` the shadow derives, under `derived` it reads the legacy roster.
 *
 * The mode read is one PK lookup, paid only when `CUTOVER_SHADOW` is on —
 * opt-in diagnostics, not the request path's standing cost.
 *
 * Awaited rather than fired into `waitUntil`: it costs little, this is a
 * low-traffic site, and a cancelled background write would lose exactly the
 * evidence the flip gate depends on. Deleted in phase 4 (#212), not at the
 * flip — the quiet period between flag and freeze-lift is where this signal
 * matters most.
 */
export async function compareInShadow(
  env: Env,
  ctx: AuthContext,
  associationDay: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const mode = await getCutoverMode(env);
    const legacy =
      mode === 'derived' ? await readLegacyRosterContext(env, ctx.userId) : ctx;
    const derived =
      mode === 'derived'
        ? ctx
        : await deriveAccess(env, ctx.userId, associationDay);
    const comparison = compareContexts(legacy, derived);
    if (comparison.matched) return;
    await recordMismatch(env, ctx.userId, 'request', comparison, now);
  } catch (error) {
    // Deliberately swallowed. The shadow model failing must never deny a
    // request the authoritative model already allowed.
    console.error('shadow comparison failed', {
      accountId: ctx.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
