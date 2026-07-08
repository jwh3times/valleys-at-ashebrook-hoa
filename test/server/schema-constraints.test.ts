import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  manualApprovalQueue,
  owners,
  properties,
  propertyVerifications,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(manualApprovalQueue);
  await db.delete(propertyVerifications);
  await db.delete(userPropertyLinks);
  await db.delete(owners);
  await db.delete(properties);
  await db.delete(users);
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

function userRow(id: string) {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: 'homeowner',
  };
}

async function seedUserAndProperty(userId: string, propertyId: string) {
  const db = getDb(env);
  await db.insert(users).values(userRow(userId));
  await db
    .insert(properties)
    .values(propRow(propertyId, `${propertyId} main st`));
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
    await seedUserAndProperty('u1', 'prop1');
    await db.insert(userPropertyLinks).values(linkRow('l1', 'u1', 'prop1'));
    await expect(
      db.insert(userPropertyLinks).values(linkRow('l2', 'u1', 'prop1')),
    ).rejects.toThrow();
  });

  it('allows one user linked to different properties', async () => {
    const db = getDb(env);
    await db.insert(users).values(userRow('u1'));
    await db
      .insert(properties)
      .values([propRow('prop1', '1 main st'), propRow('prop2', '2 main st')]);
    await db.insert(userPropertyLinks).values(linkRow('l1', 'u1', 'prop1'));
    await db.insert(userPropertyLinks).values(linkRow('l2', 'u1', 'prop2'));
    expect((await db.select().from(userPropertyLinks)).length).toBe(2);
  });

  it('rejects an owner for a missing property', async () => {
    const db = getDb(env);
    await expect(
      db.insert(owners).values({
        id: 'o1',
        propertyId: 'missing',
        fullName: 'Owner',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('allows an owner for an existing property', async () => {
    const db = getDb(env);
    await db.insert(properties).values(propRow('prop1', '1 main st'));
    await db.insert(owners).values({
      id: 'o1',
      propertyId: 'prop1',
      fullName: 'Owner',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await db.select().from(owners)).length).toBe(1);
  });

  it('rejects property links with missing parents', async () => {
    const db = getDb(env);
    await db.insert(users).values(userRow('u1'));
    await db.insert(properties).values(propRow('prop1', '1 main st'));

    await expect(
      db
        .insert(userPropertyLinks)
        .values(linkRow('missing-user', 'missing', 'prop1')),
    ).rejects.toThrow();
    await expect(
      db
        .insert(userPropertyLinks)
        .values(linkRow('missing-property', 'u1', 'missing')),
    ).rejects.toThrow();
  });

  it('rejects property verification rows with missing parents', async () => {
    const db = getDb(env);
    await db.insert(users).values(userRow('u1'));
    await db.insert(properties).values(propRow('prop1', '1 main st'));
    const row = {
      id: 'pv1',
      userId: 'u1',
      propertyId: 'prop1',
      channel: 'email' as const,
      codeHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
    };

    await expect(
      db.insert(propertyVerifications).values({ ...row, userId: 'missing' }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(propertyVerifications)
        .values({ ...row, id: 'pv2', propertyId: 'missing' }),
    ).rejects.toThrow();
  });

  it('allows property verification rows with existing parents', async () => {
    const db = getDb(env);
    await seedUserAndProperty('u1', 'prop1');
    await db.insert(propertyVerifications).values({
      id: 'pv1',
      userId: 'u1',
      propertyId: 'prop1',
      channel: 'email',
      codeHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    expect((await db.select().from(propertyVerifications)).length).toBe(1);
  });

  it('rejects manual approval queue rows for a missing user', async () => {
    const db = getDb(env);
    await expect(
      db.insert(manualApprovalQueue).values({
        id: 'maq1',
        userId: 'missing',
        claimedAddress: '1 Main St',
        reason: 'No roster match',
        createdAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('allows manual approval queue rows for an existing user', async () => {
    const db = getDb(env);
    await db.insert(users).values(userRow('u1'));
    await db.insert(manualApprovalQueue).values({
      id: 'maq1',
      userId: 'u1',
      claimedAddress: '1 Main St',
      reason: 'No roster match',
      createdAt: new Date(),
    });
    expect((await db.select().from(manualApprovalQueue)).length).toBe(1);
  });
});
