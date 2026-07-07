import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Don't make real Resend/Twilio calls during sign-up's email-verification step.
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { createAuth } from '../../src/server/auth';
import { sendEmail } from '../../src/server/auth/senders';
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

  it('trusts the localhost dev origin for state-changing auth requests', async () => {
    const auth = createAuth(env, undefined, env.BETTER_AUTH_URL);
    const res = await auth.handler(
      new Request('http://localhost:4321/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:4321',
        },
        body: JSON.stringify({
          email: 'nobody-localhost@example.com',
          password: 'a-valid-password-123',
        }),
      }),
    );
    // A trusted origin proceeds to the credential check (401 for an unknown
    // user); an untrusted origin is rejected with 403 before that.
    expect(res.status).not.toBe(403);
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

  it('redirects a valid reset email callback to the reset-password page with a token', async () => {
    const auth = createAuth(env, undefined, env.BETTER_AUTH_URL);
    await auth.handler(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'reset-callback@example.com',
          password: 'a-valid-password-123',
          name: 'Reset Callback',
        }),
      }),
    );

    vi.mocked(sendEmail).mockClear();
    const requestRes = await auth.handler(
      new Request('http://localhost/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'reset-callback@example.com',
          redirectTo: '/reset-password',
        }),
      }),
    );

    expect(requestRes.status).toBe(200);
    const resetEmail = vi
      .mocked(sendEmail)
      .mock.calls.find(([, , subject]) =>
        String(subject).startsWith('Reset your password'),
      );
    expect(resetEmail).toBeDefined();
    const resetUrl = String(resetEmail![3]).replace('Reset link: ', '');

    const callbackRes = await auth.handler(
      new Request(resetUrl, { redirect: 'manual' }),
    );

    expect(callbackRes.status).toBe(302);
    const location = new URL(callbackRes.headers.get('location')!);
    expect(location.pathname).toBe('/reset-password');
    expect(location.searchParams.get('token')).toBeTruthy();
  });

  it('redirects an invalid reset email callback to the reset-password error state', async () => {
    const auth = createAuth(env, undefined, env.BETTER_AUTH_URL);
    const callbackRes = await auth.handler(
      new Request(
        'http://localhost/api/auth/reset-password/not-a-token?callbackURL=%2Freset-password',
        { redirect: 'manual' },
      ),
    );

    expect(callbackRes.status).toBe(302);
    const location = new URL(callbackRes.headers.get('location')!);
    expect(location.pathname).toBe('/reset-password');
    expect(location.searchParams.get('error')).toBe('INVALID_TOKEN');
  });
});
