import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { GET, POST } from '../../src/pages/api/admin/roles';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { eq } from 'drizzle-orm';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// This version of vitest-pool-workers does not roll back D1 writes between
// `it` blocks within a file (only `beforeAll` runs against pristine storage),
// so tests that rely on the *total* count of board members (the last-board
// guard) must clear leftover rows from previous tests before seeding.
//
// The mode is set explicitly rather than left absent: this file is the claim
// that the `legacy` branch of the re-pointed route (#221) is what the site
// always did, so it must exercise that branch by name, not by default.
beforeEach(async () => {
  await getDb(env).delete(users);
  await getDb(env).delete(cutoverSettings);
  await getDb(env)
    .insert(cutoverSettings)
    .values({ key: 'cutover_mode', value: 'legacy', updatedAt: new Date() });
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
    expect(await res.text()).toBe('Cannot demote the last board member');
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-solo'));
    expect(u.role).toBe('board');
  });

  it('still answers 204 for a target who is not a board member', async () => {
    // The pre-#221 route counted first and then ran an unconditional update,
    // so demoting a non-board account was a harmless no-op answering 204.
    // Folding the count into the update's WHERE must not turn that into a
    // spurious "last board member" refusal.
    await mkUser('rd-a', 'a@example.com', 'board');
    await mkUser('rd-b', 'b@example.com', 'board');
    await mkUser('rd-home', 'home@example.com', 'homeowner');
    const res = await post({ action: 'demote', userId: 'rd-home' });
    expect(res.status).toBe(204);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-home'));
    expect(u.role).toBe('homeowner');
  });

  it('refuses any demotion while only one board member remains — even of a non-board target', async () => {
    // Bit-for-bit legacy parity: the historical route checked the count
    // before looking at the target at all, so a board of one answered 409 to
    // every demotion, including a pointless one. The re-point keeps that
    // answer rather than quietly changing it to a 204 no-op.
    await mkUser('rd-solo', 'solo@example.com', 'board');
    await mkUser('rd-home', 'home@example.com', 'homeowner');
    const res = await post({ action: 'demote', userId: 'rd-home' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Cannot demote the last board member');
  });

  it('never empties the board, even when two demotions race', async () => {
    // The race #221 closes: both requests used to read "two board members
    // remain" and then both update. The count now lives inside the update's
    // WHERE, so the second one finds itself alone and refuses.
    await mkUser('rd-a', 'a@example.com', 'board');
    await mkUser('rd-b', 'b@example.com', 'board');
    const [a, b] = await Promise.all([
      post({ action: 'demote', userId: 'rd-a' }),
      post({ action: 'demote', userId: 'rd-b' }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([204, 409]);
    const remaining = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.role, 'board'));
    expect(remaining).toHaveLength(1);
  });

  it('refuses the second of two sequential demotions of the last two', async () => {
    await mkUser('rd-a', 'a@example.com', 'board');
    await mkUser('rd-b', 'b@example.com', 'board');
    expect((await post({ action: 'demote', userId: 'rd-a' })).status).toBe(204);
    expect((await post({ action: 'demote', userId: 'rd-b' })).status).toBe(409);
    const remaining = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.role, 'board'));
    expect(remaining.map((u) => u.id)).toEqual(['rd-b']);
  });
});
