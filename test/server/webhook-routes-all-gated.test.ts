import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { configurePayments, unconfigurePayments } from './payments-fixtures';

/**
 * Structural guard, sibling of `admin-routes-all-gated.test.ts`: EVERY exported
 * verb of EVERY module under src/pages/api/webhooks/ refuses an unsigned
 * request (ADR 0025, #541).
 *
 * A webhook has no session to check. Its only gate is the signature, so a
 * webhook route that forgot to verify would accept anything from anyone. This
 * enumerates the directory, so the route itself is what makes the suite fail:
 * with a provider configured an unsigned request is `400`; without one the
 * route does not exist, `404`. Middleware applies only the write freeze here,
 * so there is no backstop — this suite is the layer.
 */
const modules = import.meta.glob('../../src/pages/api/webhooks/**/*.ts', {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

afterEach(unconfigurePayments);

const cases: { name: string; verb: string; handler: unknown }[] = [];
for (const [path, mod] of Object.entries(modules)) {
  const name =
    path.split('/src/pages/api/webhooks/')[1]?.replace(/\.ts$/, '') ?? path;
  for (const verb of VERBS) {
    const handler = mod[verb];
    if (typeof handler === 'function') cases.push({ name, verb, handler });
  }
}

const call = (name: string, verb: string, handler: unknown) =>
  (handler as (c: unknown) => Promise<Response>)({
    request: new Request(`http://localhost/api/webhooks/${name}`, {
      method: verb,
      headers: { 'content-type': 'application/json' },
      body: verb === 'GET' ? undefined : '{"id":"evt_unsigned"}',
    }),
  });

describe('every webhook route refuses an unsigned request', () => {
  it('found webhook route modules to check', () => {
    // Guards against a glob that matches nothing, which would make every
    // assertion below pass vacuously.
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(1);
    expect(cases.map((c) => `${c.name} ${c.verb}`)).toContain('payments POST');
  });

  it('exports only POST', () => {
    expect(cases.filter((c) => c.verb !== 'POST')).toEqual([]);
  });

  for (const { name, verb, handler } of cases) {
    it(`${name} ${verb} answers 400 to an unsigned request when configured`, async () => {
      configurePayments();
      expect((await call(name, verb, handler)).status).toBe(400);
    });

    it(`${name} ${verb} answers 404 when no provider is configured`, async () => {
      unconfigurePayments();
      expect((await call(name, verb, handler)).status).toBe(404);
    });
  }
});
