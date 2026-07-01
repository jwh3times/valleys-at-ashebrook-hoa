import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { createAuth } from '../../src/server/auth';

beforeAll(async () => {
  // env.MIGRATIONS is a test-only binding (D1Migration[] injected by the workers pool).
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('auth config', () => {
  it('rejects sign-up with a too-short password', async () => {
    const auth = createAuth(env, undefined, env.BETTER_AUTH_URL);
    const res = await auth.handler(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'a@b.com',
          password: 'short',
          name: 'A',
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
