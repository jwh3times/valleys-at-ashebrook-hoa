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

export function requirePropertyAccess(
  ctx: AuthContext,
  propertyId: string,
): void {
  if (ctx.role === 'board') return;
  if (ctx.role === 'homeowner' && ctx.propertyIds.includes(propertyId)) return;
  throw new Forbidden('not your property');
}
