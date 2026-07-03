import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Don't make real Resend/Twilio calls during sign-up's email-verification step.
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { createAuth } from '../../src/server/auth';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

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

  it('creates a user on a valid sign-up (drizzle adapter resolves the users model)', async () => {
    const auth = createAuth(env, undefined, env.BETTER_AUTH_URL);
    await auth.handler(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'newuser@example.com',
          password: 'a-valid-password-123',
          name: 'New User',
        }),
      }),
    );
    const rows = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.email, 'newuser@example.com'));
    expect(rows.length).toBe(1);
  });
});
