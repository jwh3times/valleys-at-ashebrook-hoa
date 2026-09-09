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
  it('verifies email, signs in, and signs in with a replacement password after reset', async () => {
    const auth = createAuth({ ...env }, undefined, 'http://localhost:4321');
    const email = 'upgrade-flow@example.com';
    const password = 'original-password-123';
    const post = (path: string, body: Record<string, string>) =>
      auth.handler(
        new Request(`http://localhost:4321/api/auth/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': '192.0.2.80',
          },
          body: JSON.stringify(body),
        }),
      );
    vi.mocked(sendEmail).mockClear();
    expect(
      (await post('sign-up/email', { email, password, name: 'Upgrade Tester' }))
        .status,
    ).toBe(200);
    expect((await post('sign-in/email', { email, password })).status).toBe(403);
    const verificationEmail = vi
      .mocked(sendEmail)
      .mock.calls.find(([, , subject]) =>
        subject.startsWith('Verify your account'),
      );
    expect(verificationEmail).toBeDefined();
    const verification = await auth.handler(
      new Request(verificationEmail![3].replace('Verify link: ', '')),
    );
    expect(verification.status).toBe(302);
    const signedIn = await post('sign-in/email', { email, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('set-cookie')).toContain('HttpOnly');
    expect(signedIn.headers.get('set-cookie')).toContain('SameSite=Lax');
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe(email);
    expect(
      (
        await post('request-password-reset', {
          email,
          redirectTo: '/reset-password',
        })
      ).status,
    ).toBe(200);
    const resetEmail = vi
      .mocked(sendEmail)
      .mock.calls.find(([, , subject]) =>
        subject.startsWith('Reset your password'),
      );
    expect(resetEmail).toBeDefined();
    const callback = await auth.handler(
      new Request(resetEmail![3].replace('Reset link: ', '')),
    );
    const token = new URL(callback.headers.get('location')!).searchParams.get(
      'token',
    )!;
    const newPassword = 'replacement-password-456';
    const resets = await Promise.all(
      Array.from({ length: 3 }, () =>
        post('reset-password', { token, newPassword }),
      ),
    );
    expect(resets.filter((response) => response.status === 200)).toHaveLength(
      1,
    );
    expect(resets.filter((response) => response.status === 400)).toHaveLength(
      2,
    );
    expect(
      (await post('sign-in/email', { email, password: newPassword })).status,
    ).toBe(200);
  });

  it('rejects sign-up with a too-short password', async () => {
    const auth = createAuth(env, undefined, env.BETTER_AUTH_URL);
    const res = await auth.handler(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'a@b.test',
          password: 'short',
          name: 'A',
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  function signInFromLocalhost(baseURL: string | undefined) {
    const auth = createAuth(env, undefined, baseURL);
    return auth.handler(
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
  }

  it('trusts the localhost dev origin when the app is configured to run there', async () => {
    const res = await signInFromLocalhost('http://localhost:4321');
    // A trusted origin proceeds to the credential check (401 for an unknown
    // user); an untrusted origin is rejected with 403 before that.
    expect(res.status).not.toBe(403);
  });

  it('does not trust the localhost dev origin in a production deployment', async () => {
    const res = await signInFromLocalhost('https://ashebrookresidents.com');
    expect(res.status).toBe(403);
  });

  it('falls back to the requested origin when no base URL is configured', async () => {
    // Better Auth infers its base URL from the request when none is configured,
    // and a base URL is trusted automatically — so the origin list is not the only
    // thing in play here. Production always sets BETTER_AUTH_URL (wrangler.toml
    // [vars]), which is what makes the conditional above meaningful. Pinned so the
    // conditional is never read as a guarantee that holds without that var.
    const res = await signInFromLocalhost(undefined);
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
