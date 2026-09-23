import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { confirmPropertyVerification } from '../../src/server/verification/property';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  propertyVerifications,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';
import { hashCode } from '../../src/server/verification/codes';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(propertyVerifications);
  await db.delete(userPropertyLinks);
  await db.delete(properties);
  await db.delete(users);
});

describe('verification confirm — re-verifying the same home', () => {
  it('is idempotent: still ok, exactly one link, no duplicate-key error', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(users).values({
      id: 'rv-user',
      name: 'Repeat Verify',
      email: 'rv-user@example.com',
      emailVerified: true,
      role: 'homeowner',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(properties).values({
      id: 'rv-prop',
      address: '7 Repeat Ave',
      addressNormalized: '7 repeat ave',
      unit: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    const seedCode = async (id: string, code: string) =>
      db.insert(propertyVerifications).values({
        id,
        userId: 'rv-user',
        propertyId: 'rv-prop',
        channel: 'email',
        codeHash: await hashCode(code, env.BETTER_AUTH_SECRET),
        expiresAt: new Date(now.getTime() + 600_000),
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
      });

    await seedCode('rv-1', '111111');
    expect(
      (await confirmPropertyVerification(env, 'rv-user', '111111')).ok,
    ).toBe(true);

    await seedCode('rv-2', '222222');
    expect(
      (await confirmPropertyVerification(env, 'rv-user', '222222')).ok,
    ).toBe(true);

    const links = await db
      .select()
      .from(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, 'rv-user'));
    expect(links.length).toBe(1);
  });
});
