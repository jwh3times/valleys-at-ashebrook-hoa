import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Structural guard: EVERY exported verb of EVERY module under
 * src/pages/api/admin/ must reject an anonymous caller.
 *
 * The per-route gate tests each cover one resource, so a new admin route shipped
 * without `requireBoard` breaks nothing that already exists — nobody notices
 * until it is live. This test enumerates the directory instead, so the route
 * itself is what makes the suite fail.
 *
 * It is deliberately paired with, not a replacement for, the middleware prefix
 * gate in src/middleware.ts: the Workers pool invokes handlers directly and
 * bypasses middleware entirely, so this proves the in-handler guard is really
 * there rather than relying on the production backstop.
 */
const modules = import.meta.glob('../../src/pages/api/admin/*.ts', {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('every admin route rejects an anonymous caller', () => {
  it('found admin route modules to check', () => {
    // Guards against a glob that silently matches nothing, which would make
    // every assertion below vacuously pass.
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(13);
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
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const { name, verb, handler } of cases) {
    it(`${name} ${verb} rejects anonymous`, async () => {
      const res = await (handler as (c: unknown) => Promise<Response>)({
        request: new Request(`http://localhost/api/admin/${name}`, {
          method: verb,
          headers: { 'content-type': 'application/json' },
          // No body: the guard must run before any body read, so a handler that
          // parses first would fail here rather than returning 401.
        }),
      });
      expect(res.status, `${name} ${verb} must not succeed`).toBe(401);
    });
  }
});
