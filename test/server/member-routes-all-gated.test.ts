import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';

/**
 * Structural guard for the homeowner-write surface, sibling of
 * admin-routes-all-gated.test.ts: EVERY exported verb of EVERY module under
 * src/pages/api/member/ and the live-voting route must (a) answer 404 with
 * officialMode off — even to a signed-in homeowner, so the surface is
 * unadvertised — (b) reject an anonymous caller with 401 when their feature
 * flags are on, and (c) reject a visitor-role caller with 403 when their
 * feature flags are on. Only the voting route additionally hides behind the
 * liveVotingEnabled setting. A new route shipped without its per-route guard
 * is what makes this suite fail.
 */
const modules = {
  ...import.meta.glob('../../src/pages/api/member/**/*.ts', { eager: true }),
  ...import.meta.glob('../../src/pages/api/vote.ts', { eager: true }),
} as Record<string, Record<string, unknown>>;

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(settings).where(eq(settings.key, 'site'));
});

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

describe('every member and voting route is feature- and auth-gated', () => {
  it('found member and voting route modules to check', () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(3);
  });

  const cases: {
    name: string;
    route: string;
    verb: string;
    handler: unknown;
    isVoting: boolean;
  }[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const route = `/api/${path.split('/src/pages/api/')[1]?.replace(/\.ts$/, '')}`;
    const name = route.replace('/api/', '');
    const isVoting = route === '/api/vote';
    for (const verb of VERBS) {
      const handler = mod[verb];
      if (typeof handler === 'function')
        cases.push({ name, route, verb, handler, isVoting });
    }
  }

  it('discovered a plausible number of verbs', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const { name, route, verb, handler, isVoting } of cases) {
    it(`${name} ${verb} is 404 with officialMode off, even signed in`, async () => {
      await setSiteSettings(false, true);
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost${route}`, {
          method: verb,
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
        }),
        locals: {
          authContext: { userId: 'u1', role: 'homeowner', propertyIds: [] },
        },
      });
      expect(res.status, `${name} ${verb} must hide behind the mode`).toBe(404);
    });

    it(`${name} ${verb} applies liveVotingEnabled only to voting`, async () => {
      await setSiteSettings(true, false);
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost${route}`, {
          method: verb,
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
        }),
        locals: { authContext: null },
      });
      expect(res.status, `${name} ${verb} used the wrong feature flags`).toBe(
        isVoting ? 404 : 401,
      );
    });

    it(`${name} ${verb} rejects anonymous with officialMode on`, async () => {
      await setSiteSettings(true, true);
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost${route}`, {
          method: verb,
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
          // No body: the gate must run before any body read.
        }),
        locals: { authContext: null },
      });
      expect(res.status, `${name} ${verb} must not succeed`).toBe(401);
    });

    it(`${name} ${verb} rejects a visitor-role caller with officialMode on`, async () => {
      await setSiteSettings(true, true);
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost${route}`, {
          method: verb,
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
        }),
        locals: {
          authContext: { userId: 'u2', role: 'visitor', propertyIds: [] },
        },
      });
      expect(res.status, `${name} ${verb} must not succeed`).toBe(403);
    });
  }
});
