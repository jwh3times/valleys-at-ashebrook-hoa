import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';

/**
 * Structural guard for the homeowner-write surface, sibling of
 * admin-routes-all-gated.test.ts: EVERY exported verb of EVERY module under
 * src/pages/api/member/ must (a) answer 404 with officialMode off — even to
 * a signed-in homeowner, so the surface is unadvertised — (b) reject an
 * anonymous caller with 401 when the mode is on, and (c) reject a
 * visitor-role caller with 403 when the mode is on. A new member route
 * shipped without requireMemberApi is what makes this suite fail.
 */
const modules = import.meta.glob('../../src/pages/api/member/*.ts', {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(settings).where(eq(settings.key, 'site'));
});

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

describe('every member route is officialMode- and auth-gated', () => {
  it('found member route modules to check', () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(2);
  });

  const cases: { name: string; verb: string; handler: unknown }[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const name = path.split('/').pop() ?? path;
    for (const verb of VERBS) {
      const handler = mod[verb];
      if (typeof handler === 'function') cases.push({ name, verb, handler });
    }
  }

  it('discovered a plausible number of verbs', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  for (const { name, verb, handler } of cases) {
    it(`${name} ${verb} is 404 with officialMode off, even signed in`, async () => {
      await setOfficialMode(false);
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost/api/member/${name}`, {
          method: verb,
          headers: { 'content-type': 'application/json' },
        }),
        locals: {
          authContext: { userId: 'u1', role: 'homeowner', propertyIds: [] },
        },
      });
      expect(res.status, `${name} ${verb} must hide behind the mode`).toBe(404);
    });

    it(`${name} ${verb} rejects anonymous with officialMode on`, async () => {
      await setOfficialMode(true);
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost/api/member/${name}`, {
          method: verb,
          headers: { 'content-type': 'application/json' },
          // No body: the gate must run before any body read.
        }),
      });
      expect(res.status, `${name} ${verb} must not succeed`).toBe(401);
    });

    it(`${name} ${verb} rejects a visitor-role caller with officialMode on`, async () => {
      await setOfficialMode(true);
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost/api/member/${name}`, {
          method: verb,
          headers: { 'content-type': 'application/json' },
        }),
        locals: {
          authContext: { userId: 'u2', role: 'visitor', propertyIds: [] },
        },
      });
      expect(res.status, `${name} ${verb} must not succeed`).toBe(403);
    });
  }
});
