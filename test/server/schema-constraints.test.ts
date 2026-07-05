import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { properties, userPropertyLinks } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(properties);
  await db.delete(userPropertyLinks);
});

function propRow(id: string, addressNormalized: string) {
  const now = new Date();
  return {
    id,
    address: addressNormalized.toUpperCase(),
    addressNormalized,
    unit: null,
    status: 'active' as const,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

function linkRow(id: string, userId: string, propertyId: string) {
  return {
    id,
    userId,
    propertyId,
    verifiedAt: new Date(),
    method: 'otp_email' as const,
  };
}

describe('D1 schema constraints', () => {
  it('rejects a second property with the same normalized address', async () => {
    const db = getDb(env);
    await db.insert(properties).values(propRow('p1', '1 main st'));
    await expect(
      db.insert(properties).values(propRow('p2', '1 main st')),
    ).rejects.toThrow();
  });

  it('allows properties with distinct normalized addresses', async () => {
    const db = getDb(env);
    await db.insert(properties).values(propRow('p1', '1 main st'));
    await db.insert(properties).values(propRow('p2', '2 main st'));
    expect((await db.select().from(properties)).length).toBe(2);
  });

  it('rejects a duplicate (userId, propertyId) link', async () => {
    const db = getDb(env);
    await db.insert(userPropertyLinks).values(linkRow('l1', 'u1', 'prop1'));
    await expect(
      db.insert(userPropertyLinks).values(linkRow('l2', 'u1', 'prop1')),
    ).rejects.toThrow();
  });

  it('allows one user linked to different properties', async () => {
    const db = getDb(env);
    await db.insert(userPropertyLinks).values(linkRow('l1', 'u1', 'prop1'));
    await db.insert(userPropertyLinks).values(linkRow('l2', 'u1', 'prop2'));
    expect((await db.select().from(userPropertyLinks)).length).toBe(2);
  });
});
