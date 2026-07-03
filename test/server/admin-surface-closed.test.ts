// Spec-mandated regression guard (see permissions.ts): the `board` role holds
// no Better Auth admin-plugin capabilities (impersonate/ban/set-role are
// intentionally NOT granted — role changes go through direct DB writes in
// api/admin/roles.ts and members.ts instead). test/unit/permissions.test.ts
// already proves that at the access-control-object level; this test proves it
// at the HTTP layer, driving the real Better Auth handler against Miniflare
// D1/KV, so a future better-auth upgrade can't silently reopen the surface.
//
// Verified against the installed better-auth@1.6.23 (node_modules/better-auth):
// - Endpoint paths: node_modules/better-auth/dist/plugins/admin/routes.mjs
//   defines `/admin/impersonate-user` and `/admin/ban-user` (POST).
// - Denial code: both handlers call `hasPermission({ permissions: { user:
//   [...] } })` and, on failure, `throw APIError.from("FORBIDDEN", ...)`.
//   `FORBIDDEN` maps to HTTP 403 in node_modules/better-call/dist/error.mjs
//   (`statusCodes.FORBIDDEN === 403`), and this permission check happens only
//   *after* `adminMiddleware` (same file) has already confirmed a session
//   exists (throwing 401 via `APIError.fromStatus("UNAUTHORIZED")` otherwise).
//   So 403 here can only mean "authenticated, but not permitted" — a 401
//   would mean the session cookie was never accepted, i.e. a broken test
//   setup, not a security pass.
// - get-session shape: node_modules/better-auth/dist/api/routes/session.mjs
//   `getSession` returns `ctx.json({ session, user })` on success, so
//   `body.user.role` is the right assertion path.
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

const auth = () => createAuth(env, undefined, env.BETTER_AUTH_URL);

const PASSWORD = 'a-valid-password-123';

// Signs a user up through the real handler, then promotes them to `board`
// directly in D1 (bypassing the email-verification link and the app's own
// role-grant flow — board is never self-grantable through the app), then
// signs in through the real handler to get a genuine session cookie.
async function boardSessionCookie(email: string): Promise<string> {
  const a = auth();
  await a.handler(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Board User' }),
    }),
  );
  await getDb(env)
    .update(users)
    .set({ emailVerified: true, role: 'board' })
    .where(eq(users.email, email));
  const signIn = await a.handler(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  const setCookie = signIn.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(`sign-in returned no Set-Cookie (status ${signIn.status})`);
  }
  return setCookie.split(';')[0]; // "better-auth.session_token=..." — the name=value pair
}

describe('Better Auth admin surface is closed to board sessions', () => {
  it('a live, authenticated board session is denied (403) on impersonate and ban', async () => {
    const cookie = await boardSessionCookie('board-actor@example.com');
    const a = auth();

    // Prove the session is genuinely authenticated as board *first* — this is
    // what rules out a later 403 being a false pass caused by an unrelated
    // 401 (e.g. a bad cookie).
    const sess = await a.handler(
      new Request('http://localhost/api/auth/get-session', {
        headers: { cookie },
      }),
    );
    expect(sess.status).toBe(200);
    const sessBody = (await sess.json()) as { user?: { role?: string } } | null;
    expect(sessBody?.user?.role).toBe('board');

    await getDb(env).insert(users).values({
      id: 'target-1',
      name: 'Target',
      email: 'target@example.com',
      emailVerified: true,
      role: 'homeowner',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const impersonate = await a.handler(
      new Request('http://localhost/api/auth/admin/impersonate-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ userId: 'target-1' }),
      }),
    );
    expect(impersonate.status).toBe(403);

    const ban = await a.handler(
      new Request('http://localhost/api/auth/admin/ban-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ userId: 'target-1' }),
      }),
    );
    expect(ban.status).toBe(403);
  });
});
