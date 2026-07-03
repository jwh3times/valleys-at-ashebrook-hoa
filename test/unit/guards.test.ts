import { describe, it, expect } from 'vitest';
import {
  requireRole,
  requirePropertyAccess,
  Forbidden,
} from '../../src/server/authz/guards';

const homeownerCtx = {
  userId: 'u1',
  role: 'homeowner' as const,
  propertyIds: ['o1'],
};
const boardCtx = { userId: 'u2', role: 'board' as const, propertyIds: [] };

describe('guards', () => {
  it('requireRole rejects a homeowner from board-only access', () => {
    expect(() => requireRole(homeownerCtx, 'board')).toThrow(Forbidden);
  });
  it('requireRole allows board for homeowner-level access', () => {
    expect(() => requireRole(boardCtx, 'homeowner')).not.toThrow();
  });
  it('requirePropertyAccess blocks a homeowner from another property', () => {
    expect(() => requirePropertyAccess(homeownerCtx, 'o2')).toThrow(Forbidden);
  });
  it('requirePropertyAccess allows a homeowner for their own property', () => {
    expect(() => requirePropertyAccess(homeownerCtx, 'o1')).not.toThrow();
  });
  it('requirePropertyAccess allows board for any property', () => {
    expect(() => requirePropertyAccess(boardCtx, 'o2')).not.toThrow();
  });
  it('requireRole blocks a visitor from homeowner access', () => {
    expect(() =>
      requireRole(
        { userId: 'u', role: 'visitor', propertyIds: [] },
        'homeowner',
      ),
    ).toThrow(Forbidden);
  });
  it('requireRole allows same-rank access', () => {
    expect(() => requireRole(homeownerCtx, 'homeowner')).not.toThrow();
  });
  it('requireRole fails closed for an unknown role', () => {
    expect(() =>
      requireRole(
        { userId: 'u', role: 'wat' as never, propertyIds: [] },
        'homeowner',
      ),
    ).toThrow(Forbidden);
  });
  it('requirePropertyAccess blocks a visitor even with a matching propertyId', () => {
    expect(() =>
      requirePropertyAccess(
        { userId: 'u', role: 'visitor', propertyIds: ['o1'] },
        'o1',
      ),
    ).toThrow(Forbidden);
  });
});
