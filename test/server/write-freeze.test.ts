import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import {
  isWriteFrozen,
  isMutatingMethod,
  writeFreezeError,
} from '../../src/server/authz/write-freeze';
import { requireBoard } from '../../src/server/authz/api-guards';
import { requireMemberApi } from '../../src/server/authz/member-guards';
import { requireVotingApi } from '../../src/server/authz/voting-guards';
import type { AuthContext } from '../../src/server/authz/guards';

/**
 * The operator write freeze — the ADR 0022 phase-3 mechanism that halts
 * mutations while leaving public reads and sign-in live, and a phase-2 entry
 * criterion in its own right (the reversal drill cannot be performed against a
 * switch that does not exist).
 *
 * The per-route guard layer is what these tests exercise, matching the
 * deliberate ADR 0013 split: the Workers pool invokes handlers directly and
 * never runs middleware, so the guard is the enforced-and-tested layer.
 * Middleware coverage lives in middleware-write-freeze.test.ts.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(cutoverSettings);
  await db.delete(settings).where(eq(settings.key, 'site'));
});

async function setFreeze(value: 'on' | 'off') {
  const db = getDb(env);
  await db.delete(cutoverSettings);
  await db
    .insert(cutoverSettings)
    .values({ key: 'write_freeze', value, updatedAt: new Date() });
}

async function setSiteSettings(official: boolean, live: boolean) {
  const db = getDb(env);
  await db.delete(settings).where(eq(settings.key, 'site'));
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({
      officialMode: official,
      liveVotingEnabled: live,
    }),
    updatedAt: new Date(),
  });
}

const board: AuthContext = {
  userId: 'board-1',
  role: 'board',
  propertyIds: [],
};
const homeowner: AuthContext = {
  userId: 'homeowner-1',
  role: 'homeowner',
  propertyIds: ['property-1'],
};

function localsFor(ctx: AuthContext | null) {
  return { authContext: ctx } as unknown as App.Locals;
}

function req(path: string, method: string) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
    },
  });
}

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('reading the freeze setting', () => {
  it('is not frozen when the row is absent', async () => {
    // The normal state of a database that has never been frozen. Migration
    // 0021 creates the table but seeds no row, so absence must not read as an
    // error and must not read as frozen.
    expect(await isWriteFrozen(env)).toBe(false);
  });

  it('is not frozen when the row says off', async () => {
    await setFreeze('off');
    expect(await isWriteFrozen(env)).toBe(false);
  });

  it('is frozen when the row says on', async () => {
    await setFreeze('on');
    expect(await isWriteFrozen(env)).toBe(true);
  });

  it('fails closed when the setting cannot be read', async () => {
    // Unknown state resolves to the most restrictive behavior, the same rule
    // getSiteSettings follows. Cheap in practice: every mutation needs D1
    // anyway, so a D1 failure was going to fail the request regardless.
    const brokenEnv = {
      ...env,
      DATABASE: {
        prepare() {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;
    expect(await isWriteFrozen(brokenEnv)).toBe(true);
  });

  it('takes effect without a restart, and reverses', async () => {
    // Nothing is cached, which is the entire reason this is a D1 row rather
    // than a var: the operator flips it mid-flight and it must take within
    // seconds, then reverse just as fast. This is the reversal drill in
    // miniature.
    expect(await isWriteFrozen(env)).toBe(false);
    await setFreeze('on');
    expect(await isWriteFrozen(env)).toBe(true);
    await setFreeze('off');
    expect(await isWriteFrozen(env)).toBe(false);
  });
});

describe('which verbs count as mutating', () => {
  it('treats writes as mutating and reads as not', () => {
    for (const verb of MUTATING) expect(isMutatingMethod(verb)).toBe(true);
    for (const verb of ['GET', 'HEAD', 'OPTIONS'])
      expect(isMutatingMethod(verb)).toBe(false);
  });

  it('matches the method case-insensitively', () => {
    expect(isMutatingMethod('post')).toBe(true);
  });
});

describe('writeFreezeError', () => {
  it('answers 503, never 404 — this is maintenance, not masked existence', async () => {
    await setFreeze('on');
    const res = await writeFreezeError(env, req('/api/admin/site', 'POST'));
    expect(res?.status).toBe(503);
  });

  it('skips the setting read entirely for a non-mutating request', async () => {
    // A broken database proves the read never happened: if it did, fail-closed
    // would return a 503 here.
    const brokenEnv = {
      ...env,
      DATABASE: {
        prepare() {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;
    expect(
      await writeFreezeError(brokenEnv, req('/api/admin/site', 'GET')),
    ).toBeNull();
  });

  it('skips the setting read entirely for an exempt path', async () => {
    // Same proof for the other short-circuit: sign-in must not even touch the
    // freeze setting, so a database failure can never take authentication down
    // through this path.
    const brokenEnv = {
      ...env,
      DATABASE: {
        prepare() {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;
    expect(
      await writeFreezeError(brokenEnv, req('/api/auth/sign-in', 'POST')),
    ).toBeNull();
    expect(
      await writeFreezeError(brokenEnv, req('/api/bootstrap/board', 'POST')),
    ).toBeNull();
  });

  it('derives coverage from the path, so no call site can hold a stale scope', async () => {
    await setFreeze('on');
    // One call shape, three different answers — all from the request itself.
    expect(
      (await writeFreezeError(env, req('/api/admin/site', 'GET')))?.status,
    ).toBeUndefined();
    expect(
      (await writeFreezeError(env, req('/api/member/proxies', 'GET')))?.status,
    ).toBe(503);
    expect(
      (await writeFreezeError(env, req('/api/auth/sign-in', 'POST')))?.status,
    ).toBeUndefined();
  });
});

describe('homeowner verification under a freeze', () => {
  // The surface the ticket did not name. /api/verify/confirm writes
  // user_property_links and property_verifications — the legacy tables the
  // authoritative backfill reads — so a verification landing mid-run is
  // precisely the drift the freeze exists to prevent.
  it('refuses a verification request and a confirmation with 503', async () => {
    await setFreeze('on');
    for (const route of ['/api/verify/request', '/api/verify/confirm']) {
      const res = await writeFreezeError(env, req(route, 'POST'));
      expect(res?.status, `${route} must be frozen`).toBe(503);
    }
  });

  it('leaves both live when not frozen', async () => {
    for (const route of ['/api/verify/request', '/api/verify/confirm']) {
      expect(await writeFreezeError(env, req(route, 'POST'))).toBeNull();
    }
  });
});

describe('the admin API under a freeze', () => {
  it('refuses every mutating verb with 503, for a board caller', async () => {
    await setFreeze('on');
    for (const verb of MUTATING) {
      const res = await requireBoard(
        localsFor(board),
        req('/api/admin/announcements', verb),
        env,
      );
      expect(res?.status, `${verb} must be frozen`).toBe(503);
    }
  });

  it('leaves board reads live, so the record stays visible and the flip can be smoke-tested', async () => {
    await setFreeze('on');
    expect(
      await requireBoard(
        localsFor(board),
        req('/api/admin/meetings', 'GET'),
        env,
      ),
    ).toBeNull();
  });

  it('answers 503 before authenticating, so no early return can leak a write through', async () => {
    await setFreeze('on');
    const res = await requireBoard(
      localsFor(null),
      req('/api/admin/announcements', 'POST'),
      env,
    );
    expect(res?.status).toBe(503);
  });

  it('still answers 401/403 normally when not frozen', async () => {
    const anonymous = await requireBoard(
      localsFor(null),
      req('/api/admin/announcements', 'POST'),
      env,
    );
    expect(anonymous?.status).toBe(401);
    const visitor = await requireBoard(
      localsFor({ userId: 'v', role: 'visitor', propertyIds: [] }),
      req('/api/admin/announcements', 'POST'),
      env,
    );
    expect(visitor?.status).toBe(403);
    expect(
      await requireBoard(
        localsFor(board),
        req('/api/admin/announcements', 'POST'),
        env,
      ),
    ).toBeNull();
  });
});

describe('the homeowner-write API under a freeze', () => {
  it('refuses every verb with 503, reads included', async () => {
    await setSiteSettings(true, true);
    await setFreeze('on');
    for (const verb of ['GET', ...MUTATING]) {
      const gate = await requireMemberApi(
        localsFor(homeowner),
        req('/api/member/proxies', verb),
        env,
      );
      expect(gate.ok, `${verb} must be frozen`).toBe(false);
      if (!gate.ok) expect(gate.res.status).toBe(503);
    }
  });

  it('keeps the officialMode 404 ahead of the freeze, so a frozen site advertises nothing', async () => {
    await setSiteSettings(false, false);
    await setFreeze('on');
    const gate = await requireMemberApi(
      localsFor(homeowner),
      req('/api/member/proxies', 'POST'),
      env,
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(404);
  });

  it('passes a homeowner through when not frozen', async () => {
    await setSiteSettings(true, true);
    const gate = await requireMemberApi(
      localsFor(homeowner),
      req('/api/member/proxies', 'POST'),
      env,
    );
    expect(gate.ok).toBe(true);
  });
});

describe('the voting API under a freeze', () => {
  it('refuses a cast with 503 — a ballot landing mid-backfill is unrecoverable', async () => {
    await setSiteSettings(true, true);
    await setFreeze('on');
    const gate = await requireVotingApi(
      localsFor(homeowner),
      req('/api/vote', 'POST'),
      env,
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(503);
  });

  it('keeps the feature-flag 404 ahead of the freeze', async () => {
    await setSiteSettings(true, false);
    await setFreeze('on');
    const gate = await requireVotingApi(
      localsFor(homeowner),
      req('/api/vote', 'POST'),
      env,
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(404);
  });

  it('answers 503 ahead of the Origin and media-type checks', async () => {
    // The freeze describes the server, not the request, so a caller with bad
    // headers gets the same answer as one with good headers.
    await setSiteSettings(true, true);
    await setFreeze('on');
    const request = new Request('http://localhost/api/vote', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'text/plain' },
    });
    const gate = await requireVotingApi(localsFor(homeowner), request, env);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(503);
  });

  it('preserves the documented guard order when not frozen', async () => {
    await setSiteSettings(true, true);
    const badOrigin = await requireVotingApi(
      localsFor(homeowner),
      new Request('http://localhost/api/vote', {
        method: 'POST',
        headers: {
          origin: 'https://evil.test',
          'content-type': 'application/json',
        },
      }),
      env,
    );
    expect(badOrigin.ok).toBe(false);
    if (!badOrigin.ok) expect(badOrigin.res.status).toBe(403);
  });
});
