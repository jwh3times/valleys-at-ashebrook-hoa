import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { cutoverSettings } from '../db/cutover-schema';

/**
 * The operator-only write freeze: a maintenance state that halts mutations
 * while leaving public reads and sign-in live.
 *
 * Built for the ADR 0022 phase-3 flip, where it is the true one-way point —
 * the authoritative backfill runs inside it, so a write landing mid-run is
 * exactly the drift the freeze exists to prevent. It is deliberately RETAINED
 * after phase 4 (see cutover-schema.ts): the next schema migration, a suspected
 * compromise, or a D1 incident all want the same switch.
 *
 * Frozen surfaces, per issue #211:
 *   - MUTATING verbs on /api/admin/*  (board reads stay live, so the flip can
 *     be smoke-tested and the board can still see the record)
 *   - EVERY verb on /api/member/*
 *   - POST /api/vote
 *
 * Live throughout: public pages, /api/content/*, /api/files/*, sign-in
 * (/api/auth/*), and /api/bootstrap/board — the last because flip step 4
 * bootstraps the first System Administrator while the freeze is still on.
 *
 * Frozen requests answer 503 (a maintenance state), never 404 (which this
 * codebase reserves for masked existence).
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True for the verbs that can change state. HEAD/GET/OPTIONS are reads. */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Which requests a surface freezes.
 *
 *  `mutations`  — the admin API: reads stay live.
 *  `everything` — the homeowner-write surfaces, which have no read-only half
 *                 worth keeping up during a freeze.
 */
export type FreezeScope = 'mutations' | 'everything';

/**
 * Read the `write_freeze` singleton. UNCACHED, by design and not by accident:
 * the operator flips this row directly and it must take effect within seconds
 * and without a deploy, which is the entire reason it is a D1 row rather than a
 * var. One indexed primary-key lookup on a two-row table.
 *
 * FAIL-CLOSED: an exception here is read as frozen, matching this codebase's
 * rule that unknown states resolve to the most restrictive behavior. The cost
 * is bounded — every mutation needs D1 anyway, so a D1 failure was going to
 * fail the request regardless, and 503 is a better answer than a 500 from
 * halfway through a write. An ABSENT row is not an error: it is the normal
 * un-frozen state, and it is what a database that has never been frozen looks
 * like. The table itself has existed since migration 0021.
 */
export async function isWriteFrozen(env: Env): Promise<boolean> {
  try {
    const [row] = await getDb(env)
      .select({ value: cutoverSettings.value })
      .from(cutoverSettings)
      .where(eq(cutoverSettings.key, 'write_freeze'));
    return row?.value === 'on';
  } catch {
    return true;
  }
}

/**
 * Returns a 503 to short-circuit, or null if the request may proceed.
 *
 * Skips the D1 read entirely for a non-mutating request under `mutations`
 * scope, so admin reads pay nothing for the freeze existing.
 */
export async function writeFreezeError(
  env: Env,
  request: Request,
  scope: FreezeScope,
): Promise<Response | null> {
  if (scope === 'mutations' && !isMutatingMethod(request.method)) return null;
  if (!(await isWriteFrozen(env))) return null;
  return new Response('Site is temporarily read-only for maintenance', {
    status: 503,
  });
}
