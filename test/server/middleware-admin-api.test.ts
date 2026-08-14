import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';

// Role is swapped per test so one file can cover anonymous, homeowner, and board
// without three separate module mocks.
let role: 'visitor' | 'homeowner' | 'board' | null = null;
vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    role === null ? null : legacyAuthContext('u1', role, []),
}));

import { legacyAuthContext } from '../../src/server/authz/context';
import { onRequest } from '../../src/middleware';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

/** Same pattern as member-routes-all-gated.test.ts: seed or clear the singleton settings row. */
async function setOfficialMode(on: boolean) {
  const db = getDb(env);
  await db.delete(settings).where(eq(settings.key, 'site'));
  if (on)
    await db.insert(settings).values({
      key: 'site',
      value: JSON.stringify({ officialMode: true }),
      updatedAt: new Date(),
    });
}

beforeEach(() => {
  role = null;
});

function ctx(path: string, method = 'GET') {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url, { method }),
    url,
    locals: {} as App.Locals,
    redirect: (p: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { location: p } }),
  };
}

/** Invoke the middleware, recording whether it reached the downstream handler. */
async function run(path: string, method = 'GET') {
  let reached = false;
  const res = await (
    onRequest as never as (
      c: unknown,
      n: () => Promise<Response>,
    ) => Promise<Response>
  )(ctx(path, method), async () => {
    reached = true;
    return new Response('ok');
  });
  return { res, reached };
}

describe('middleware gate on /api/admin', () => {
  it('rejects an anonymous caller with 401 and never reaches the route', async () => {
    const { res, reached } = await run('/api/admin/announcements', 'POST');
    expect(res.status).toBe(401);
    expect(reached).toBe(false);
  });

  it('rejects an authenticated homeowner with 403 and never reaches the route', async () => {
    role = 'homeowner';
    const { res, reached } = await run('/api/admin/documents');
    expect(res.status).toBe(403);
    expect(reached).toBe(false);
  });

  it('rejects a visitor-role session with 403', async () => {
    role = 'visitor';
    const { res, reached } = await run('/api/admin/roles');
    expect(res.status).toBe(403);
    expect(reached).toBe(false);
  });

  it('lets a board caller through to the route', async () => {
    role = 'board';
    const { res, reached } = await run('/api/admin/board-people');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('gates every verb, not just GET', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const { res, reached } = await run('/api/admin/site', method);
      expect(res.status, `${method} should be gated`).toBe(401);
      expect(reached).toBe(false);
    }
  });

  it('gates a route path that does not exist yet', async () => {
    // The whole point of a prefix gate: a route added tomorrow inherits it
    // before anyone remembers to write requireBoard into the handler.
    const { res, reached } = await run('/api/admin/not-built-yet', 'POST');
    expect(res.status).toBe(401);
    expect(reached).toBe(false);
  });
});

describe('middleware gate on /api/member', () => {
  beforeEach(async () => {
    await setOfficialMode(false);
  });

  it('is 404 with officialMode off, even for a signed-in homeowner', async () => {
    role = 'homeowner';
    const { res, reached } = await run('/api/member/proxies');
    expect(res.status).toBe(404);
    expect(reached).toBe(false);
  });

  it('rejects an anonymous caller with 401 when officialMode is on', async () => {
    await setOfficialMode(true);
    const { res, reached } = await run('/api/member/proxies');
    expect(res.status).toBe(401);
    expect(reached).toBe(false);
  });

  it('rejects a visitor-role session with 403 when officialMode is on', async () => {
    await setOfficialMode(true);
    role = 'visitor';
    const { res, reached } = await run('/api/member/proxies');
    expect(res.status).toBe(403);
    expect(reached).toBe(false);
  });

  it('lets a homeowner caller through when officialMode is on', async () => {
    await setOfficialMode(true);
    role = 'homeowner';
    const { res, reached } = await run('/api/member/proxies');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('does not gate a sibling path sharing the prefix', async () => {
    // /api/members starts with "/api/member" as a bare string but is a
    // different route, same reasoning as /api/administrators above.
    await setOfficialMode(true);
    const { res, reached } = await run('/api/members');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('gates the bare /api/member path with no trailing slash', async () => {
    role = 'homeowner';
    const { res, reached } = await run('/api/member');
    expect(res.status).toBe(404);
    expect(reached).toBe(false);
  });
});

describe('middleware leaves neighbouring paths alone', () => {
  it('allows anonymous access to public content reads', async () => {
    const { res, reached } = await run('/api/content/announcements');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('allows anonymous access to the first-board bootstrap endpoint', async () => {
    // This endpoint is permanently fail-closed on its own and self-disables once
    // a board exists. Gating it here would make bootstrapping impossible.
    const { res, reached } = await run('/api/bootstrap/board', 'POST');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('allows anonymous access to the auth handler', async () => {
    const { res, reached } = await run('/api/auth/sign-in', 'POST');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('allows anonymous access to homeowner verification', async () => {
    const { res, reached } = await run('/api/verify/request', 'POST');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('does not gate a path that merely contains the substring', async () => {
    const { res, reached } = await run('/api/content/admin-notes');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('does not gate a sibling path sharing the prefix', async () => {
    // /api/administrators starts with "/api/admin" as a bare string but is a
    // different route. The gate matches the segment, not the prefix.
    const { res, reached } = await run('/api/administrators');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('gates the bare /api/admin path with no trailing slash', async () => {
    const { res, reached } = await run('/api/admin', 'POST');
    expect(res.status).toBe(401);
    expect(reached).toBe(false);
  });

  it('still redirects an anonymous caller away from the /admin page', async () => {
    const { res } = await run('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('applies security headers to a gated response', async () => {
    const { res } = await run('/api/admin/announcements', 'POST');
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
