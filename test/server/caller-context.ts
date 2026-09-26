import type {
  AuthContext,
  Capability,
  Role,
} from '../../src/server/authz/guards';

/** A supplied caller for handler tests that exercise gates without session I/O.
 * Tests of actual authority seed the roster and resolve the real context. */
export function callerContext(
  userId: string,
  contentTier: Role,
  lotIds: string[],
): AuthContext {
  const capabilities = new Set<Capability>();
  if (contentTier === 'board') capabilities.add('board');
  if (contentTier === 'homeowner' || lotIds.length > 0)
    capabilities.add('member');
  return {
    userId,
    personId: null,
    capabilities,
    lotIds,
    contentTier,
    hasCurrentBoardTerm: false,
  };
}
