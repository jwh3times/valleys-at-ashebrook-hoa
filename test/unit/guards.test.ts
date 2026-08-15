import { describe, it, expect } from 'vitest';
import {
  requireRole,
  requireCapability,
  requirePropertyAccess,
  Forbidden,
  type AuthContext,
  type Capability,
  type Role,
} from '../../src/server/authz/guards';

/**
 * `legacyAuthContext` lives in `context.ts`, which imports Better Auth and D1 —
 * neither of which loads in the jsdom/node program. This is the same synthesis
 * kept deliberately small, and `test/server/auth-context.test.ts` pins that the
 * real one produces exactly this.
 */
function ctx(
  userId: string,
  role: Role,
  lotIds: string[] = [],
  extra: Capability[] = [],
): AuthContext {
  const capabilities = new Set<Capability>(extra);
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
    lotIds,
    contentTier: role,
    hasCurrentBoardTerm: false,
    role,
    propertyIds: lotIds,
  };
}

const homeownerCtx = ctx('u1', 'homeowner', ['o1']);
const boardCtx = ctx('u2', 'board');
const visitorCtx = ctx('u3', 'visitor');

describe('requireRole — content tier, which is genuinely ordered', () => {
  it('rejects a homeowner from board-only content', () => {
    expect(() => requireRole(homeownerCtx, 'board')).toThrow(Forbidden);
  });
  it('allows board for homeowner-level content', () => {
    expect(() => requireRole(boardCtx, 'homeowner')).not.toThrow();
  });
  it('blocks a visitor from homeowner content', () => {
    expect(() => requireRole(visitorCtx, 'homeowner')).toThrow(Forbidden);
  });
  it('allows same-rank access', () => {
    expect(() => requireRole(homeownerCtx, 'homeowner')).not.toThrow();
  });
  it('fails closed for an unknown tier', () => {
    expect(() => requireRole(ctx('u', 'wat' as never), 'homeowner')).toThrow(
      Forbidden,
    );
  });
});

describe('requireCapability — a set, not a ladder', () => {
  it('rejects a homeowner from board capability', () => {
    expect(() => requireCapability(homeownerCtx, 'board')).toThrow(Forbidden);
  });

  it('rejects everyone from systemAdmin unless they hold it', () => {
    // The capability with no legacy equivalent. Nothing implies it — not board,
    // not owning every Lot in the association.
    expect(() => requireCapability(boardCtx, 'systemAdmin')).toThrow(Forbidden);
    expect(() => requireCapability(homeownerCtx, 'systemAdmin')).toThrow(
      Forbidden,
    );
  });

  it('does not order the levels — systemAdmin carries board only because derivation adds it', () => {
    // A caller holding systemAdmin alone has no board capability here. The real
    // derivation adds `board` explicitly (see toDerivedAccess); this asserts
    // that nothing in the guard infers it, so removing that line would fail a
    // test rather than silently keep working.
    const bare = ctx('u4', 'visitor', [], ['systemAdmin']);
    expect(() => requireCapability(bare, 'systemAdmin')).not.toThrow();
    expect(() => requireCapability(bare, 'board')).toThrow(Forbidden);
    expect(() => requireCapability(bare, 'member')).toThrow(Forbidden);
  });

  it('grants member from Lot authority, not from rank', () => {
    expect(() => requireCapability(homeownerCtx, 'member')).not.toThrow();
    expect(() => requireCapability(visitorCtx, 'member')).toThrow(Forbidden);
  });

  it('lets a legacy board caller keep the member pass', () => {
    // The compatibility that makes `cutover_mode = legacy` behave exactly as
    // the site did before. Under `derived`, a board member owning no Lot loses
    // this — one of the two entries on the explained-mismatch allow-list.
    expect(() => requireCapability(boardCtx, 'member')).not.toThrow();
  });
});

describe('requirePropertyAccess', () => {
  it('blocks a homeowner from another property', () => {
    expect(() => requirePropertyAccess(homeownerCtx, 'o2')).toThrow(Forbidden);
  });
  it('allows a homeowner for their own property', () => {
    expect(() => requirePropertyAccess(homeownerCtx, 'o1')).not.toThrow();
  });
  it('allows board for any property', () => {
    expect(() => requirePropertyAccess(boardCtx, 'o2')).not.toThrow();
  });
  it('blocks a visitor even with a matching lot id', () => {
    expect(() =>
      requirePropertyAccess(ctx('u', 'visitor', ['o1']), 'o1'),
    ).toThrow(Forbidden);
  });
});
