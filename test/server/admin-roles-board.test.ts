import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET, POST } from '../../src/pages/api/admin/roles';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// This version of vitest-pool-workers does not roll back D1 writes between
// `it` blocks within a file (only `beforeAll` runs against pristine storage),
// so tests that rely on the *total* count of board members (the last-board
// guard) must clear leftover rows from previous tests before seeding.
beforeEach(async () => {
  await getDb(env).delete(users);
});

async function mkUser(id: string, email: string, role: string) {
  const now = new Date();
  await getDb(env).insert(users).values({
    id,
    name: id,
    email,
    emailVerified: true,
    role,
    createdAt: now,
    updatedAt: now,
  });
}

function post(body: unknown) {
  return POST({
    request: new Request('http://localhost/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

// vitest-pool-workers isolates storage per test (writes inside an `it` are
// rolled back; only beforeAll writes persist), so each test seeds its own users
// and starts from an empty users table. Do NOT rely on state from a prior `it`.
describe('admin roles — board handoff', () => {
  it('promotes an existing account to board by email', async () => {
    await mkUser('rd-home', 'incoming@example.com', 'homeowner');
    const res = await post({
      action: 'promote',
      email: 'incoming@example.com',
    });
    expect(res.status).toBe(204);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-home'));
    expect(u.role).toBe('board');
  });

  it('404s promoting an unknown email', async () => {
    const res = await post({ action: 'promote', email: 'nobody@example.com' });
    expect(res.status).toBe(404);
  });

  it('lists current board members', async () => {
    await mkUser('rd-list', 'listed@example.com', 'board');
    const res = await GET({
      request: new Request('http://localhost/api/admin/roles'),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { board: { email: string }[] };
    expect(body.board.some((m) => m.email === 'listed@example.com')).toBe(true);
  });

  it('demotes a board member when others remain', async () => {
    await mkUser('rd-a', 'a@example.com', 'board');
    await mkUser('rd-b', 'b@example.com', 'board');
    const res = await post({ action: 'demote', userId: 'rd-b' });
    expect(res.status).toBe(204);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-b'));
    expect(u.role).toBe('visitor');
  });

  it('refuses to demote the last board member (409)', async () => {
    await mkUser('rd-solo', 'solo@example.com', 'board');
    const res = await post({ action: 'demote', userId: 'rd-solo' });
    expect(res.status).toBe(409);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-solo'));
    expect(u.role).toBe('board');
  });
});
