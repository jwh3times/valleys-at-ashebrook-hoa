import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';

// Same module-mock pattern as middleware-admin-api.test.ts: one role variable
// swapped per test rather than three separate mocks.
let role: 'visitor' | 'homeowner' | 'board' | null = null;
vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () =>
    role === null ? null : { userId: 'u1', role, propertyIds: [] },
}));

import { onRequest } from '../../src/middleware';

/**
 * The middleware half of the write freeze — the production backstop, paired
 * with (not a replacement for) the per-route guards covered in
 * write-freeze.test.ts, per ADR 0013.
 *
 * The second half of this file is the more important one: it pins what the
 * freeze must NOT take down. A maintenance switch that also breaks public
 * pages or sign-in is not usable during a flip, and the phase-3 procedure
 * depends on residents still being able to read the site and the operator
 * still being able to sign in while the freeze holds.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  role = null;
  await getDb(env).delete(cutoverSettings);
});

async function setFreeze(value: 'on' | 'off') {
  const db = getDb(env);
  await db.delete(cutoverSettings);
  await db
    .insert(cutoverSettings)
    .values({ key: 'write_freeze', value, updatedAt: new Date() });
}

async function setOfficialMode(on: boolean, live = false) {
  const db = getDb(env);
  await db.delete(settings).where(eq(settings.key, 'site'));
  if (on)
    await db.insert(settings).values({
      key: 'site',
      value: JSON.stringify({
        officialMode: true,
        liveVotingEnabled: live,
      }),
      updatedAt: new Date(),
    });
}

function ctx(path: string, method: string) {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url, {
      method,
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
    }),
    url,
    locals: {} as App.Locals,
    redirect: (p: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { location: p } }),
  };
}

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

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('the freeze halts mutations at the middleware', () => {
  beforeEach(async () => {
    await setFreeze('on');
  });

  it('refuses every mutating admin verb with 503 and never reaches the route', async () => {
    role = 'board';
    for (const method of MUTATING) {
      const { res, reached } = await run('/api/admin/site', method);
      expect(res.status, `${method} should be frozen`).toBe(503);
      expect(reached).toBe(false);
    }
  });

  it('leaves admin reads live', async () => {
    role = 'board';
    const { res, reached } = await run('/api/admin/meetings');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('freezes a route path that does not exist yet', async () => {
    // Same reasoning as the prefix auth gate: a route added tomorrow inherits
    // the freeze before anyone remembers to think about it.
    role = 'board';
    const { res, reached } = await run('/api/admin/not-built-yet', 'POST');
    expect(res.status).toBe(503);
    expect(reached).toBe(false);
  });

  it('refuses the member surface on every verb', async () => {
    await setOfficialMode(true);
    role = 'homeowner';
    for (const method of ['GET', ...MUTATING]) {
      const { res, reached } = await run('/api/member/proxies', method);
      expect(res.status, `${method} should be frozen`).toBe(503);
      expect(reached).toBe(false);
    }
  });

  it('keeps the officialMode 404 ahead of the freeze on the member surface', async () => {
    await setOfficialMode(false);
    role = 'homeowner';
    const { res } = await run('/api/member/proxies', 'POST');
    expect(res.status).toBe(404);
  });

  it('refuses a vote cast with 503', async () => {
    await setOfficialMode(true, true);
    role = 'homeowner';
    const { res, reached } = await run('/api/vote', 'POST');
    expect(res.status).toBe(503);
    expect(reached).toBe(false);
  });

  it('keeps the feature-flag 404 ahead of the freeze on the voting surface', async () => {
    await setOfficialMode(true, false);
    role = 'homeowner';
    const { res } = await run('/api/vote', 'POST');
    expect(res.status).toBe(404);
  });

  it('refuses homeowner verification, which no middleware branch claims', async () => {
    // Reaches /api/verify/* through the deny-by-default fallthrough rather
    // than a named branch — the property that makes coverage survive a route
    // nobody thought about.
    role = 'homeowner';
    for (const route of ['/api/verify/request', '/api/verify/confirm']) {
      const { res, reached } = await run(route, 'POST');
      expect(res.status, `${route} should be frozen`).toBe(503);
      expect(reached).toBe(false);
    }
  });

  it('refuses a mutating path that does not exist yet, anywhere in the app', async () => {
    role = 'board';
    for (const route of ['/api/not-built-yet', '/some/future/form']) {
      const { res, reached } = await run(route, 'POST');
      expect(res.status, `${route} should be frozen`).toBe(503);
      expect(reached).toBe(false);
    }
  });

  it('still applies security headers to a frozen response', async () => {
    role = 'board';
    const { res } = await run('/api/admin/announcements', 'POST');
    expect(res.status).toBe(503);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('the freeze leaves the site readable and signable-in', () => {
  beforeEach(async () => {
    await setFreeze('on');
    await setOfficialMode(true, true);
  });

  it('leaves public pages live', async () => {
    const { res, reached } = await run('/');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('leaves public content reads live', async () => {
    const { res, reached } = await run('/api/content/announcements');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('leaves gated document downloads live', async () => {
    const { res, reached } = await run('/api/files/some-document-id');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('leaves reads live on surfaces whose writes are frozen', async () => {
    // Deny-by-default covers mutations, not reads. Residents keep reading the
    // record while the board cannot change it.
    for (const route of ['/api/content/documents', '/api/verify/request']) {
      const { res, reached } = await run(route, 'GET');
      expect(res.status, `${route} GET should be live`).toBe(200);
      expect(reached).toBe(true);
    }
  });

  it('leaves sign-in live', async () => {
    // A freeze that locked the operator out of their own admin panel would be
    // unusable during the flip it exists for.
    const { res, reached } = await run('/api/auth/sign-in', 'POST');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('leaves the first-board bootstrap live', async () => {
    // Flip step 4 bootstraps the first System Administrator while the freeze
    // is still on. Freezing this endpoint would deadlock the procedure.
    const { res, reached } = await run('/api/bootstrap/board', 'POST');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('leaves the admin page itself reachable for a board caller', async () => {
    role = 'board';
    const { res, reached } = await run('/admin');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });
});

describe('lifting the freeze restores mutations', () => {
  it('answers normally again once the row says off', async () => {
    role = 'board';
    await setFreeze('on');
    expect((await run('/api/admin/site', 'POST')).res.status).toBe(503);
    await setFreeze('off');
    const { res, reached } = await run('/api/admin/site', 'POST');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('is off when no row has ever been written', async () => {
    role = 'board';
    const { res, reached } = await run('/api/admin/site', 'POST');
    expect(res.status).toBe(200);
    expect(reached).toBe(true);
  });
});
