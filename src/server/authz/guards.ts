export class Unauthorized extends Error {}
export class Forbidden extends Error {}

export type Role = 'visitor' | 'homeowner' | 'board';
export interface AuthContext {
  userId: string;
  role: Role;
  ownerIds: string[];
}

const RANK: Record<Role, number> = { visitor: 0, homeowner: 1, board: 2 };

export function requireRole(ctx: AuthContext, role: Role): void {
  if (RANK[ctx.role] < RANK[role]) throw new Forbidden(`requires ${role}`);
}

export function requireOwnerAccess(ctx: AuthContext, ownerId: string): void {
  if (ctx.role === 'board') return;
  if (ctx.role === 'homeowner' && ctx.ownerIds.includes(ownerId)) return;
  throw new Forbidden('not your property');
}
