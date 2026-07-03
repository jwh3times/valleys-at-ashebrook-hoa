import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST } from '../../src/pages/api/admin/members';
import { getDb } from '../../src/server/db/client';
import { users, userPropertyLinks } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function mkUser(id: string, role: string) {
  const now = new Date();
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      role,
      createdAt: now,
      updatedAt: now,
    });
}

function revoke(userId: string) {
  return POST({
    request: new Request('http://localhost/api/admin/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'revoke', userId }),
    }),
  } as never);
}

describe('members revoke', () => {
  it('revokes a homeowner to visitor and deletes their links', async () => {
    await mkUser('mr-home', 'homeowner');
    await getDb(env).insert(userPropertyLinks).values({
      id: 'link-1',
      userId: 'mr-home',
      propertyId: 'p',
      verifiedAt: new Date(),
      method: 'otp_email',
    });
    const res = await revoke('mr-home');
    expect(res.status).toBe(204);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'mr-home'));
    expect(u.role).toBe('visitor');
    const links = await getDb(env)
      .select()
      .from(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, 'mr-home'));
    expect(links).toHaveLength(0);
  });

  it('refuses to demote a board member here (409)', async () => {
    await mkUser('mr-board', 'board');
    const res = await revoke('mr-board');
    expect(res.status).toBe(409);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'mr-board'));
    expect(u.role).toBe('board');
  });
});
