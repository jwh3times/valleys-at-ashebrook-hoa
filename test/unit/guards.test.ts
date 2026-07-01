import { describe, it, expect } from 'vitest';
import {
  requireRole,
  requireOwnerAccess,
  Forbidden,
} from '../../src/server/authz/guards';

const homeownerCtx = {
  userId: 'u1',
  role: 'homeowner' as const,
  ownerIds: ['o1'],
};
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
  it('requireRole blocks a visitor from homeowner access', () => {
    expect(() =>
      requireRole({ userId: 'u', role: 'visitor', ownerIds: [] }, 'homeowner'),
    ).toThrow(Forbidden);
  });
  it('requireRole allows same-rank access', () => {
    expect(() => requireRole(homeownerCtx, 'homeowner')).not.toThrow();
  });
  it('requireRole fails closed for an unknown role', () => {
    expect(() =>
      requireRole(
        { userId: 'u', role: 'wat' as never, ownerIds: [] },
        'homeowner',
      ),
    ).toThrow(Forbidden);
  });
  it('requireOwnerAccess blocks a visitor even with a matching ownerId', () => {
    expect(() =>
      requireOwnerAccess(
        { userId: 'u', role: 'visitor', ownerIds: ['o1'] },
        'o1',
      ),
    ).toThrow(Forbidden);
  });
});
