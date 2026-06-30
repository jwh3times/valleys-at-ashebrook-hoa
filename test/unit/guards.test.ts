import { describe, it, expect } from 'vitest';
import { requireRole, requireOwnerAccess, Forbidden } from '../../src/server/authz/guards';

const homeownerCtx = { userId: 'u1', role: 'homeowner' as const, ownerIds: ['o1'] };
const boardCtx = { userId: 'u2', role: 'board' as const, ownerIds: [] };

describe('guards', () => {
  it('requireRole rejects a homeowner from board-only access', () => {
    expect(() => requireRole(homeownerCtx, 'board')).toThrow(Forbidden);
  });
  it('requireRole allows board for homeowner-level access', () => {
    expect(() => requireRole(boardCtx, 'homeowner')).not.toThrow();
  });
  it('requireOwnerAccess blocks a homeowner from another owner record', () => {
    expect(() => requireOwnerAccess(homeownerCtx, 'o2')).toThrow(Forbidden);
  });
  it('requireOwnerAccess allows a homeowner for their own owner record', () => {
    expect(() => requireOwnerAccess(homeownerCtx, 'o1')).not.toThrow();
  });
  it('requireOwnerAccess allows board for any owner record', () => {
    expect(() => requireOwnerAccess(boardCtx, 'o2')).not.toThrow();
  });
});
