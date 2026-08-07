import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';

let role: 'visitor' | 'homeowner' | 'board' | null = null;
vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: vi.fn(),
}));

import { getAuthContext } from '../../src/server/authz/context';
import { onRequest } from '../../src/middleware';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  role = null;
  vi.mocked(getAuthContext).mockReset();
  vi.mocked(getAuthContext).mockImplementation(async () =>
    role === null ? null : { userId: 'u1', role, propertyIds: [] },
  );
  await getDb(env).delete(settings).where(eq(settings.key, 'site'));
});

async function setSiteSettings(official: boolean, live: boolean) {
  await getDb(env)
    .insert(settings)
    .values({
      key: 'site',
      value: JSON.stringify({
        officialMode: official,
        liveVotingEnabled: live,
      }),
      updatedAt: new Date(),
    });
}

function fakeContext(path: string, init?: RequestInit) {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url, init),
    url,
    locals: {} as App.Locals,
    redirect: (p: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { location: p } }),
  };
}

async function run(path: string, init?: RequestInit) {
  let reached = false;
  const res = await (
    onRequest as never as (
      c: unknown,
      n: () => Promise<Response>,
    ) => Promise<Response>
  )(fakeContext(path, init), async () => {
    reached = true;
    return new Response('ok');
  });
  return { res, reached };
}

const validVotingRequest: RequestInit = {
  method: 'POST',
  headers: {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
};

describe('route protection', () => {
  it('redirects an anonymous visitor away from /admin to /login', async () => {
    const res = await (
      onRequest as never as (
        c: unknown,
        n: () => Promise<Response>,
      ) => Promise<Response>
    )(fakeContext('/admin'), async () => new Response('ok'));
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('allows an anonymous visitor through a public path', async () => {
    const res = await (
      onRequest as never as (
        c: unknown,
        n: () => Promise<Response>,
      ) => Promise<Response>
    )(fakeContext('/'), async () => new Response('ok'));
    expect(res.status).toBe(200);
  });
});

describe('live-voting route protection', () => {
  it('returns 404 without resolving auth when official mode is off', async () => {
    await setSiteSettings(false, true);
    const { res, reached } = await run('/api/vote', {
      method: 'POST',
      headers: {
        origin: 'https://evil.test',
        'content-type': 'text/plain',
      },
    });
    expect(res.status).toBe(404);
    expect(reached).toBe(false);
    expect(vi.mocked(getAuthContext).mock.calls.length).toBe(0);
  });

  it('returns 404 without resolving auth when live voting is off', async () => {
    await setSiteSettings(true, false);
    const { res, reached } = await run('/api/vote', {
      method: 'POST',
      headers: {
        origin: 'https://evil.test',
        'content-type': 'text/plain',
      },
    });
    expect(res.status).toBe(404);
    expect(reached).toBe(false);
    expect(vi.mocked(getAuthContext).mock.calls.length).toBe(0);
  });

  it('returns 403 for a missing or foreign Origin before JSON or auth', async () => {
    await setSiteSettings(true, true);
    const invalidOriginHeaders: HeadersInit[] = [
      { 'content-type': 'text/plain' },
      { origin: 'https://evil.test', 'content-type': 'text/plain' },
    ];
    for (const headers of invalidOriginHeaders) {
      vi.mocked(getAuthContext).mockClear();
      const { res, reached } = await run('/api/vote', {
        method: 'POST',
        headers,
      });
      expect(res.status).toBe(403);
      expect(reached).toBe(false);
      expect(vi.mocked(getAuthContext).mock.calls.length).toBe(0);
    }
  });

  it('returns 415 for a same-origin non-JSON request before auth', async () => {
    await setSiteSettings(true, true);
    const { res, reached } = await run('/api/vote', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'text/plain',
      },
    });
    expect(res.status).toBe(415);
    expect(reached).toBe(false);
    expect(vi.mocked(getAuthContext).mock.calls.length).toBe(0);
  });

  it('preserves anonymous and visitor rejection after both flags', async () => {
    await setSiteSettings(true, true);
    const anonymous = await run('/api/vote', validVotingRequest);
    expect(anonymous.res.status).toBe(401);
    expect(anonymous.reached).toBe(false);
    expect(vi.mocked(getAuthContext).mock.calls.length).toBe(1);

    role = 'visitor';
    const visitor = await run('/api/vote', validVotingRequest);
    expect(visitor.res.status).toBe(403);
    expect(visitor.reached).toBe(false);
    expect(vi.mocked(getAuthContext).mock.calls.length).toBe(2);
  });

  it('passes homeowner and board rank after both flags', async () => {
    await setSiteSettings(true, true);
    for (const allowedRole of ['homeowner', 'board'] as const) {
      role = allowedRole;
      const { res, reached } = await run('/api/vote', validVotingRequest);
      expect(res.status, `${allowedRole} should pass`).toBe(200);
      expect(reached).toBe(true);
    }
  });

  it('does not gate member proxy routes on live voting', async () => {
    await setSiteSettings(true, false);
    role = 'homeowner';
    const { res, reached } = await run('/api/member/proxies');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('does not gate a sibling path sharing the prefix', async () => {
    const { res, reached } = await run('/api/votes');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });
});
