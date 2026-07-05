import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Bootstrapping signs up the first board account, which triggers the sign-up
// verification email — keep the senders inert so no real network call happens.
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { handleBootstrapBoard } from '../../src/server/auth/seed-board';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';

const SECRET = 'boot-secret-123';

function envWith(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env,
    BOOTSTRAP_SECRET: SECRET,
    BOARD_EMAIL: 'board@example.com',
    BOARD_PASSWORD: 'a-valid-password-123',
    BOARD_NAME: 'First Board',
    ...overrides,
  } as unknown as Env;
}

function req(secret?: string): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (secret !== undefined) headers['x-bootstrap-secret'] = secret;
  return new Request('http://localhost/api/bootstrap/board', {
    method: 'POST',
    headers,
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  // Each test starts from a fresh, un-bootstrapped site (no board account).
  await getDb(env).delete(users);
});

describe('POST /api/bootstrap/board', () => {
  it('204 creates the first board account, then is permanently inert (410)', async () => {
    const first = await handleBootstrapBoard(envWith(), req(SECRET));
    expect(first.status).toBe(204);

    const rows = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.email, 'board@example.com'));
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe('board');
    expect(rows[0].emailVerified).toBe(true);

    // Self-disabling: a second call is refused because a board now exists.
    const second = await handleBootstrapBoard(envWith(), req(SECRET));
    expect(second.status).toBe(410);
  });

  it('410 once a board account exists, even with a valid secret + config', async () => {
    await getDb(env).insert(users).values({
      id: 'existing-board',
      name: 'Existing Board',
      email: 'existing@example.com',
      role: 'board',
    });
    const res = await handleBootstrapBoard(envWith(), req(SECRET));
    expect(res.status).toBe(410);
  });

  it('403 on a wrong secret', async () => {
    const res = await handleBootstrapBoard(envWith(), req('wrong'));
    expect(res.status).toBe(403);
  });

  it('403 when the secret binding is unset (an unset secret is never open)', async () => {
    const res = await handleBootstrapBoard(
      envWith({ BOOTSTRAP_SECRET: undefined }),
      req('anything'),
    );
    expect(res.status).toBe(403);
  });

  it('403 when the secret header is missing', async () => {
    const res = await handleBootstrapBoard(envWith(), req());
    expect(res.status).toBe(403);
  });

  it('400 when BOARD_* config is missing', async () => {
    const res = await handleBootstrapBoard(
      envWith({ BOARD_EMAIL: undefined }),
      req(SECRET),
    );
    expect(res.status).toBe(400);
    // Nothing was created.
    const rows = await getDb(env).select().from(users);
    expect(rows.length).toBe(0);
  });
});
