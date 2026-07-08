import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  manualApprovalQueue,
  properties,
  propertyVerifications,
  users,
} from '../../src/server/db/schema';
import { cleanupVerificationState } from '../../src/server/cleanup/verification';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(manualApprovalQueue);
  await db.delete(propertyVerifications);
  await db.delete(properties);
  await db.delete(users);

  await db.insert(users).values({
    id: 'u1',
    name: 'User One',
    email: 'u1@example.com',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: 'homeowner',
  });
  await db.insert(properties).values({
    id: 'p1',
    address: '1 Main St',
    addressNormalized: '1 main st',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

function daysBefore(base: Date, days: number) {
  return new Date(base.getTime() - days * 24 * 60 * 60 * 1000);
}

describe('cleanupVerificationState', () => {
  it('deletes consumed or expired verification rows older than the retention cutoff', async () => {
    const db = getDb(env);
    const now = new Date('2026-07-08T12:00:00Z');
    const row = {
      userId: 'u1',
      propertyId: 'p1',
      channel: 'email' as const,
      codeHash: 'hash',
      attempts: 0,
      createdAt: now,
    };
    await db.insert(propertyVerifications).values([
      {
        ...row,
        id: 'old-consumed',
        expiresAt: daysBefore(now, 1),
        consumedAt: daysBefore(now, 31),
      },
      {
        ...row,
        id: 'old-expired',
        expiresAt: daysBefore(now, 31),
        consumedAt: null,
      },
      {
        ...row,
        id: 'recent-expired',
        expiresAt: daysBefore(now, 1),
        consumedAt: null,
      },
      {
        ...row,
        id: 'pending',
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: null,
      },
    ]);

    const result = await cleanupVerificationState(env, now);

    expect(result.verificationRows).toBe(2);
    const remaining = await db.select().from(propertyVerifications);
    expect(remaining.map((r) => r.id).sort()).toEqual([
      'pending',
      'recent-expired',
    ]);
  });

  it('deletes only resolved manual approval rows older than the retention cutoff', async () => {
    const db = getDb(env);
    const now = new Date('2026-07-08T12:00:00Z');
    await db.insert(manualApprovalQueue).values([
      {
        id: 'old-approved',
        userId: 'u1',
        claimedAddress: '1 Main St',
        reason: 'Matched by board',
        status: 'approved',
        createdAt: daysBefore(now, 31),
      },
      {
        id: 'old-denied',
        userId: 'u1',
        claimedAddress: '2 Main St',
        reason: 'No match',
        status: 'denied',
        createdAt: daysBefore(now, 31),
      },
      {
        id: 'old-pending',
        userId: 'u1',
        claimedAddress: '3 Main St',
        reason: 'Needs review',
        status: 'pending',
        createdAt: daysBefore(now, 31),
      },
      {
        id: 'recent-approved',
        userId: 'u1',
        claimedAddress: '4 Main St',
        reason: 'Matched by board',
        status: 'approved',
        createdAt: daysBefore(now, 1),
      },
    ]);

    const result = await cleanupVerificationState(env, now);

    expect(result.manualApprovalRows).toBe(2);
    const remaining = await db.select().from(manualApprovalQueue);
    expect(remaining.map((r) => r.id).sort()).toEqual([
      'old-pending',
      'recent-approved',
    ]);
  });
});
