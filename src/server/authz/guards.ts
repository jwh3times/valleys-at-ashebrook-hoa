export class Unauthorized extends Error {}
export class Forbidden extends Error {}

export type Role = 'visitor' | 'homeowner' | 'board';
export interface AuthContext {
  userId: string;
  role: Role;
  propertyIds: string[];
}

const RANK: Record<Role, number> = { visitor: 0, homeowner: 1, board: 2 };

export function requireRole(ctx: AuthContext, role: Role): void {
  const ctxRank = RANK[ctx.role] ?? -1;
  if (ctxRank < RANK[role]) throw new Forbidden(`requires ${role}`);
}

/**
 * Fail-closed check that a caller may act on a specific property: board can
 * touch any, a homeowner only their own, everyone else denied. No API route
 * calls this yet — it's the authorization primitive reserved for per-owner
 * private data (dues balances / violations, IMPLEMENTATION_PLAN §4.2). Covered
 * by test/unit/guards.test.ts; keep it until that feature lands.
 */
export function requirePropertyAccess(
  ctx: AuthContext,
  propertyId: string,
): void {
  if (ctx.role === 'board') return;
  if (ctx.role === 'homeowner' && ctx.propertyIds.includes(propertyId)) return;
  throw new Forbidden('not your property');
}
