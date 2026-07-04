import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the context module so we can prove the locals fast-path skips the second
// session/DB lookup entirely, and that the fallback still runs when locals is absent.
vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: vi.fn(),
}));
import { getAuthContext } from '../../src/server/authz/context';
import {
  resolveAuthContext,
  requireBoard,
} from '../../src/server/authz/api-guards';

const boardCtx = { userId: 'u1', role: 'board' as const, propertyIds: [] };
const homeownerCtx = {
  userId: 'u2',
  role: 'homeowner' as const,
  propertyIds: ['p1'],
};
const req = new Request('http://localhost/api/admin/site');

beforeEach(() => vi.mocked(getAuthContext).mockReset());

describe('resolveAuthContext', () => {
  it('returns locals.authContext without calling getAuthContext', async () => {
    const ctx = await resolveAuthContext(
      { authContext: boardCtx } as never,
      req,
      env,
    );
    expect(ctx).toEqual(boardCtx);
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it('falls back to getAuthContext when locals is undefined', async () => {
    vi.mocked(getAuthContext).mockResolvedValue(null);
    const ctx = await resolveAuthContext(undefined, req, env);
    expect(ctx).toBeNull();
    expect(getAuthContext).toHaveBeenCalledTimes(1);
  });
});

describe('requireBoard', () => {
  it('allows a board caller from locals without a second lookup', async () => {
    // Benign default; the not.toHaveBeenCalled() assertion is what proves the
    // fast-path never touches getAuthContext.
    vi.mocked(getAuthContext).mockResolvedValue(null);
    const denied = await requireBoard(
      { authContext: boardCtx } as never,
      req,
      env,
    );
    expect(denied).toBeNull();
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-board caller resolved from locals', async () => {
    const denied = await requireBoard(
      { authContext: homeownerCtx } as never,
      req,
      env,
    );
    expect(denied?.status).toBe(403);
  });

  it('falls back and fail-closes to 401 for anonymous when locals is absent', async () => {
    vi.mocked(getAuthContext).mockResolvedValue(null);
    const denied = await requireBoard(undefined, req, env);
    expect(denied?.status).toBe(401);
    expect(getAuthContext).toHaveBeenCalledTimes(1);
  });
});
