export class Unauthorized extends Error {}
export class Forbidden extends Error {}

export type Role = 'visitor' | 'homeowner' | 'board';

/**
 * Capability levels. Deliberately a SET, not a ladder — `systemAdmin` implies
 * every `board` capability, but neither implies `member`, which comes only from
 * Ownership or Representation.
 *
 * The ladder is what let a board member who owns no Lot pass the member-only
 * gate for free, and it is why a System Administrator (who need not be an Owner
 * at all) could not be added to it without handing them Lot Authority with no
 * association basis.
 */
export type Capability = 'member' | 'board' | 'systemAdmin';

export interface AuthContext {
  userId: string;
  /** The linked Person, or null. Null under `cutover_mode = legacy`, which has
   * no Person concept, and under `derived` when no current Person Link exists. */
  personId: string | null;
  capabilities: Set<Capability>;
  /** Lots this caller may act for. */
  lotIds: string[];
  /** Content sensitivity — a separate axis from what the caller may DO. */
  contentTier: Role;
  hasCurrentBoardTerm: boolean;

  /**
   * COMPATIBILITY ALIASES, retained through phase 3 and deleted in phase 4
   * (#212). `role` is `contentTier` under its old name and feeds nothing but
   * content reads; `propertyIds` is `lotIds`.
   *
   * They exist so this phase does not have to rename two identifiers across ~28
   * call sites while simultaneously changing what they mean. Renaming and
   * re-sourcing at once would make every one of those diffs impossible to review
   * for behavior change.
   */
  role: Role;
  propertyIds: string[];
}

const RANK: Record<Role, number> = { visitor: 0, homeowner: 1, board: 2 };

/**
 * Legacy rank check, retained only for content-tier questions.
 *
 * Prefer `requireCapability` for anything asking what a caller may DO. This
 * compares `contentTier`, which is genuinely ordered — `board` really does see
 * everything `homeowner` sees — unlike capability, which is not.
 */
export function requireRole(ctx: AuthContext, role: Role): void {
  const ctxRank = RANK[ctx.contentTier] ?? -1;
  if (ctxRank < RANK[role]) throw new Forbidden(`requires ${role}`);
}

/**
 * The capability primitive every route gate is built on.
 *
 * Set membership, not comparison. `systemAdmin` carries `board` because
 * derivation adds it explicitly (see `toDerivedAccess`), not because anything
 * here orders them.
 */
export function requireCapability(
  ctx: AuthContext,
  capability: Capability,
): void {
  if (!ctx.capabilities.has(capability))
    throw new Forbidden(`requires ${capability}`);
}

/**
 * Fail-closed check that a caller may act on a specific Lot: board can touch
 * any, a member only their own, everyone else denied.
 *
 * No API route calls this yet — it's the authorization primitive reserved for
 * per-owner private data (dues balances / violations, ROADMAP item 2). Covered
 * by test/unit/guards.test.ts; keep it until that feature lands.
 */
export function requirePropertyAccess(
  ctx: AuthContext,
  propertyId: string,
): void {
  if (ctx.capabilities.has('board')) return;
  if (ctx.capabilities.has('member') && ctx.lotIds.includes(propertyId)) return;
  throw new Forbidden('not your property');
}
