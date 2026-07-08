import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import {
  POST as propertiesPost,
  PATCH as propertiesPatch,
} from '../../src/pages/api/admin/properties';
import { confirmPropertyVerification } from '../../src/server/verification/property';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  propertyVerifications,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';
import { hashCode } from '../../src/server/verification/codes';

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

function postProperty(body: unknown) {
  return propertiesPost({
    request: new Request('http://localhost/api/admin/properties', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

describe('admin properties — duplicate normalized address', () => {
  it('returns 409 (not 500) instead of silently creating a second home', async () => {
    const first = await postProperty({ address: '100 Repeat Rd' });
    expect(first.status).toBe(201);
    // Different casing/spacing → same normalized form.
    const second = await postProperty({ address: '100  repeat rd ' });
    expect(second.status).toBe(409);
    expect((await getDb(env).select().from(properties)).length).toBe(1);
  });

  it('returns 409 when a PATCH would collide with another home’s address', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(properties).values([
      {
        id: 'pa',
        address: '1 A St',
        addressNormalized: '1 a st',
        unit: null,
        status: 'active',
        notes: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'pb',
        address: '2 B St',
        addressNormalized: '2 b st',
        unit: null,
        status: 'active',
        notes: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const res = await propertiesPatch({
      request: new Request('http://localhost/api/admin/properties', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pb', address: '1 A St' }),
      }),
    } as never);
    expect(res.status).toBe(409);
  });
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
