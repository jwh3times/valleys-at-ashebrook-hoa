import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthContext } from '../../src/server/authz/guards';

/**
 * `GET /api/me` answers the admin UI's "may this caller see the board
 * panels?" from the same `AuthContext` every route gate reads — never from
 * the Better Auth session's `role`, which is only the write-behind mirror
 * (#212).
 */

const current = vi.hoisted(() => ({ ctx: null as AuthContext | null }));

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => current.ctx,
}));

import { GET } from '../../src/pages/api/me';
import { derivedContext } from '../../src/server/authz/context';

function ctxWith(
  capabilities: AuthContext['capabilities'] extends Set<infer C> ? C[] : never,
  contentTier: AuthContext['contentTier'],
): AuthContext {
  return derivedContext({
    userId: 'acct-1',
    personId: 'per-1',
    capabilities: new Set(capabilities),
    lotIds: [],
    contentTier,
    hasCurrentBoardTerm: false,
    invalidBoardGrantId: null,
  });
}

function get() {
  return GET({
    request: new Request('http://localhost/api/me'),
  } as never);
}

beforeEach(() => {
  current.ctx = null;
});

describe('GET /api/me', () => {
  it('401s an anonymous caller', async () => {
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("returns the caller's own capabilities and content tier", async () => {
    current.ctx = ctxWith(['member', 'board'], 'board');
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      capabilities: ['board', 'member'],
      contentTier: 'board',
    });
  });

  it('carries no board capability for a caller the model does not grant it', async () => {
    current.ctx = ctxWith([], 'visitor');
    const res = await get();
    expect(await res.json()).toEqual({
      capabilities: [],
      contentTier: 'visitor',
    });
  });

  it('is never cached', async () => {
    current.ctx = ctxWith(['board'], 'board');
    const res = await get();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
