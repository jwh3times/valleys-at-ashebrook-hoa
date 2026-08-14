import { and, eq } from 'drizzle-orm';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import { properties, userPropertyLinks } from '../db/schema';
import { getCutoverMode } from './cutover-mode';
import { deriveAccess, type DerivedAccess } from './derive';
import type { AuthContext, Capability, Role } from './guards';

const VALID_ROLES = new Set<string>(['visitor', 'homeowner', 'board']);

/**
 * The single seam the ADR 0022 cutover swaps behind (#198, #217).
 *
 * Every guard, page, and route reads its caller from here. Which MODEL produced
 * that caller is decided by `cutover_mode` and by nothing else — there is no
 * dual-write, no read model, and no second code path through the app. That is
 * what makes the flip a flag change rather than a deploy, and the rollback a
 * flag change rather than a reconciliation.
 */

/**
 * Legacy facts, shaped as an `AuthContext`.
 *
 * The capability set here deliberately REPRODUCES THE OLD RANK LADDER: a board
 * caller gets `member` as well as `board`, exactly as `requireRole(ctx,
 * 'homeowner')` used to let them through. This is the whole reason the flip is
 * safe to land ahead of the flag: with `cutover_mode = legacy` the site behaves
 * bit-for-bit as it did before, including the behaviors derived authorization
 * deliberately removes.
 *
 * Those removals — a board member who owns no Lot losing the free pass into
 * `/api/member/*` — appear at the moment the flag flips, which is where the
 * allow-list in #206 expects them and where the announcement to residents has
 * already accounted for them. Not before, and not scattered across whichever
 * routes got migrated first.
 *
 * `personId` is null and `hasCurrentBoardTerm` false because legacy has no
 * Person and no Board Term. Neither is consulted by any legacy-mode guard.
 */
export function legacyAuthContext(
  userId: string,
  role: Role,
  propertyIds: string[],
): AuthContext {
  const capabilities = new Set<Capability>();
  if (role === 'board') {
    capabilities.add('board');
    capabilities.add('member');
  } else if (role === 'homeowner') {
    capabilities.add('member');
  }
  return {
    userId,
    personId: null,
    capabilities,
    lotIds: propertyIds,
    contentTier: role,
    hasCurrentBoardTerm: false,
    role,
    propertyIds,
  };
}

/** Derived facts, shaped as an `AuthContext`. Adds only the compat aliases. */
export function derivedContext(access: DerivedAccess): AuthContext {
  return {
    userId: access.userId,
    personId: access.personId,
    capabilities: access.capabilities,
    lotIds: access.lotIds,
    contentTier: access.contentTier,
    hasCurrentBoardTerm: access.hasCurrentBoardTerm,
    role: access.contentTier,
    propertyIds: access.lotIds,
  };
}

/** Read the legacy roster facts for an authenticated account. */
async function readLegacyFacts(
  env: Env,
  userId: string,
  rawRole: unknown,
): Promise<AuthContext> {
  const db = getDb(env);
  const links = await db
    .select({ propertyId: userPropertyLinks.propertyId })
    .from(userPropertyLinks)
    .innerJoin(properties, eq(userPropertyLinks.propertyId, properties.id))
    .where(
      and(
        eq(userPropertyLinks.userId, userId),
        eq(properties.status, 'active'),
      ),
    );
  const role: Role =
    typeof rawRole === 'string' && VALID_ROLES.has(rawRole)
      ? (rawRole as Role)
      : 'visitor';
  return legacyAuthContext(
    userId,
    role,
    links.map((l) => l.propertyId),
  );
}

/**
 * Resolve the caller for this request.
 *
 * Returns null only for an anonymous caller — no session. An authenticated
 * caller always yields a context, even one with no capabilities at all, so
 * routes can tell "nobody is signed in" (401) apart from "you are signed in and
 * this is not yours" (403). Under `derived`, an authenticated account with no
 * current Person Link is exactly that second case: `capabilities` is empty and
 * `contentTier` is `visitor`, and the gates answer 403.
 *
 * A derivation error PROPAGATES. It must never be caught into a visitor
 * context: a transient D1 failure presenting a linked board member as anonymous
 * would look exactly like a permissions bug, and would be diagnosed as one.
 */
export async function getAuthContext(
  request: Request,
  env: Env,
  associationDay: string,
): Promise<AuthContext | null> {
  const auth = createAuth(env);
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) return null;

  const mode = await getCutoverMode(env);
  if (mode === 'derived') {
    // `access.invalidBoardGrantId` names a live Board grant this refused. Its
    // recording as an Access Event (#200) is BLOCKED on a decision, not
    // forgotten — see the note on that field in derive.ts.
    return derivedContext(
      await deriveAccess(env, result.user.id, associationDay),
    );
  }
  return readLegacyFacts(
    env,
    result.user.id,
    (result.user as { role?: unknown }).role,
  );
}
