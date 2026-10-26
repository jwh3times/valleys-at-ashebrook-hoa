import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { lots, users } from '../../src/server/db/schema';
import {
  contactMethods,
  parties,
  people,
  verificationCodes,
  verificationReviewRequests,
} from '../../src/server/db/roster-schema';
import { cleanupVerificationState } from '../../src/server/cleanup/verification';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await env.DATABASE.prepare('DELETE FROM tenancy_invitations').run();
  await env.DATABASE.prepare('DELETE FROM tenancies').run();
  await env.DATABASE.prepare('DELETE FROM ownerships').run();
  await db.delete(verificationCodes);
  await db.delete(verificationReviewRequests);
  await db.delete(contactMethods);
  await db.delete(people);
  await db.delete(parties);
  await db.delete(lots);
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
  await db.insert(lots).values({
    id: 'p1',
    address: '1 Main St',
    addressNormalized: '1 main st',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(parties).values({
    id: 'party1',
    kind: 'person',
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
  await db.insert(people).values({
    partyId: 'party1',
    partyKind: 'person',
    fullName: 'Person One',
    nameNormalized: 'person one',
    updatedAt: new Date(1),
  });
  await db.insert(contactMethods).values({
    id: 'cm1',
    partyId: 'party1',
    partyKind: 'person',
    channel: 'email',
    value: 'person1@example.com',
    valueNormalized: 'person1@example.com',
    isPreferred: true,
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
});

function daysBefore(base: Date, days: number) {
  return new Date(base.getTime() - days * 24 * 60 * 60 * 1000);
}

describe('cleanupVerificationState', () => {
  it('deletes stale consumed or expired verification codes, keeps fresh pending ones', async () => {
    const db = getDb(env);
    const now = new Date('2026-07-08T12:00:00Z');
    const HOUR_MS = 60 * 60 * 1000;
    const row = {
      accountId: 'u1',
      personId: 'party1',
      contactMethodId: 'cm1',
      lotId: 'p1',
      channel: 'email' as const,
      codeHash: 'hash',
      attempts: 0,
      createdAt: now,
    };
    await db.insert(verificationCodes).values([
      {
        ...row,
        id: 'old-consumed',
        expiresAt: new Date(now.getTime() - HOUR_MS),
        consumedAt: new Date(now.getTime() - 25 * HOUR_MS),
      },
      {
        ...row,
        id: 'old-expired',
        expiresAt: new Date(now.getTime() - 25 * HOUR_MS),
        consumedAt: null,
      },
      {
        ...row,
        id: 'recent-expired',
        expiresAt: new Date(now.getTime() - HOUR_MS),
        consumedAt: null,
      },
      {
        ...row,
        id: 'pending',
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        consumedAt: null,
      },
    ]);

    const result = await cleanupVerificationState(env, now);

    expect(result.verificationCodeRows).toBe(2);
    const remaining = await db.select().from(verificationCodes);
    expect(remaining.map((r) => r.id).sort()).toEqual([
      'pending',
      'recent-expired',
    ]);
  });

  it('deletes resolved review requests older than the retention cutoff, keeps open ones forever', async () => {
    const db = getDb(env);
    const now = new Date('2026-07-08T12:00:00Z');
    await db.insert(verificationReviewRequests).values([
      {
        id: 'old-accepted',
        accountId: 'u1',
        claimedAddress: '1 Main St',
        claimedName: 'Person One',
        channel: 'email',
        internalReason: 'applicant_requested',
        status: 'accepted',
        createdAt: daysBefore(now, 40),
        resolvedAt: daysBefore(now, 31),
        resolvedByAccountId: 'u1',
      },
      {
        id: 'old-declined',
        accountId: 'u1',
        claimedAddress: '2 Main St',
        claimedName: 'Person Two',
        channel: 'sms',
        internalReason: 'person_already_linked',
        status: 'declined',
        createdAt: daysBefore(now, 40),
        resolvedAt: daysBefore(now, 31),
        resolvedByAccountId: 'u1',
      },
      {
        id: 'recent-accepted',
        accountId: 'u1',
        claimedAddress: '3 Main St',
        claimedName: 'Person Three',
        channel: 'email',
        internalReason: 'applicant_requested',
        status: 'accepted',
        createdAt: daysBefore(now, 5),
        resolvedAt: daysBefore(now, 1),
        resolvedByAccountId: 'u1',
      },
      {
        id: 'old-open',
        accountId: 'u1',
        claimedAddress: '4 Main St',
        claimedName: 'Person Four',
        channel: 'email',
        internalReason: 'applicant_requested',
        status: 'open',
        createdAt: daysBefore(now, 90),
        resolvedAt: null,
        resolvedByAccountId: null,
      },
    ]);

    const result = await cleanupVerificationState(env, now);

    expect(result.reviewRequestRows).toBe(2);
    const remaining = await db.select().from(verificationReviewRequests);
    expect(remaining.map((r) => r.id).sort()).toEqual([
      'old-open',
      'recent-accepted',
    ]);
  });

  // #294 slice 4 (spec decision 4): an invitation is good for 14 days; once
  // it has been expired for 30, whatever happened to it, it is deleted.
  it('deletes tenancy invitations that expired more than 30 days ago, keeps the rest', async () => {
    const now = new Date('2026-07-08T12:00:00Z');
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
         VALUES ('own', 'party1', 'p1', '2025-01-01', 1, 1)`,
      ),
      env.DATABASE.prepare(
        `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id, start_day, scheduled_end_day, created_at, updated_at)
         VALUES ('ten', 'party1', 'p1', 'own', '2026-01-01', '2027-01-01', 1, 1)`,
      ),
    ]);
    const invite = (id: string, expiredDaysAgo: number, consumed = false) => {
      const expiresAt = daysBefore(now, expiredDaysAgo).getTime();
      return env.DATABASE.prepare(
        `INSERT INTO tenancy_invitations (id, tenancy_id, contact_method_id,
           channel, token_hash, expires_at, consumed_at, consumed_by_account_id,
           created_at)
         VALUES (?, 'ten', 'cm1', 'email', ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        `hash-${id}`,
        expiresAt,
        consumed ? expiresAt - 1 : null,
        consumed ? 'u1' : null,
        expiresAt - 14 * 24 * 60 * 60 * 1000,
      );
    };
    await env.DATABASE.batch([
      invite('old-unused', 31),
      invite('old-consumed', 31, true),
      invite('recent', 29),
      invite('live', -5),
    ]);

    const result = await cleanupVerificationState(env, now);

    expect(result.tenancyInvitationRows).toBe(2);
    const { results } = await env.DATABASE.prepare(
      'SELECT id FROM tenancy_invitations ORDER BY id',
    ).all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(['live', 'recent']);
  });
});
