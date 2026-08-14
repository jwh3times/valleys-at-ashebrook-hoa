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
 * COVERAGE IS DENY-BY-DEFAULT. Every mutation is frozen unless its path is
 * named in ALWAYS_LIVE below, so a route added tomorrow inherits the freeze
 * without anyone remembering to think about it. That direction is deliberate:
 * the opposite arrangement — enumerating what IS frozen — makes coverage a
 * function of what somebody remembered to list, and the failure is silent.
 * `freeze-coverage.test.ts` enumerates every route module and fails if a
 * mutating route ends up live without being declared here.
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
 * How much of a path the freeze covers.
 *
 *  `exempt`     — never frozen, even for a mutation. Two paths only; see below.
 *  `everything` — frozen on every verb, reads included.
 *  `mutations`  — frozen on POST/PUT/PATCH/DELETE; reads stay live.
 */
export type FreezePolicy = 'exempt' | 'mutations' | 'everything';

/** Exact-segment containment, so /api/administrators is not "under" /api/admin. */
function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The only two surfaces that keep mutating while the site is frozen. Each is
 * here because freezing it would break the freeze's own purpose, not for
 * convenience — adding a third entry is a decision, which is why the coverage
 * test requires this list to be declared there too.
 */
const ALWAYS_LIVE: ReadonlyArray<{ base: string; why: string }> = [
  {
    base: '/api/auth',
    why: 'Sign-in writes a session row. A freeze that locks the operator out of the admin panel is unusable during the flip it exists for.',
  },
  {
    base: '/api/bootstrap/board',
    why: 'Flip step 4 bootstraps the first System Administrator while the freeze is still on. Freezing this deadlocks the procedure.',
  },
];

/**
 * Surfaces frozen on every verb rather than only on mutations. Both are
 * homeowner-write surfaces with no read-only half worth keeping live — their
 * reads exist to feed their writes, and a picker that loads but cannot submit
 * is worse than one that says the site is paused.
 */
const FROZEN_ENTIRELY = ['/api/member', '/api/vote'];

/**
 * The single authority on what the freeze covers. Both enforcement layers call
 * it, so middleware and the per-route guards cannot drift on the answer.
 *
 * Note that non-API paths fall through to `mutations`. Pages are GET renders
 * today, so this costs nothing (a non-mutating request never even reads the
 * setting) — but if an Astro form action ever lands, it is frozen by default
 * rather than by amendment.
 */
export function freezePolicyFor(path: string): FreezePolicy {
  for (const { base } of ALWAYS_LIVE) if (isUnder(path, base)) return 'exempt';
  for (const base of FROZEN_ENTIRELY)
    if (isUnder(path, base)) return 'everything';
  return 'mutations';
}

/** The exemptions, exposed so the coverage test can assert the list itself. */
export const alwaysLivePaths = (): string[] => ALWAYS_LIVE.map((e) => e.base);

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
 * Takes no scope argument on purpose: it derives coverage from the request's
 * own path through `freezePolicyFor`, so every call site is identical and none
 * of them can hold a stale opinion about what its surface freezes.
 *
 * Skips the setting read entirely for an exempt path or a non-mutating request
 * under `mutations` coverage, so reads pay nothing for the freeze existing.
 */
export async function writeFreezeError(
  env: Env,
  request: Request,
): Promise<Response | null> {
  const policy = freezePolicyFor(new URL(request.url).pathname);
  if (policy === 'exempt') return null;
  if (policy === 'mutations' && !isMutatingMethod(request.method)) return null;
  if (!(await isWriteFrozen(env))) return null;
  return new Response('Site is temporarily read-only for maintenance', {
    status: 503,
  });
}
