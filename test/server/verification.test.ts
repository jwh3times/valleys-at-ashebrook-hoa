import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { requestPropertyVerification, confirmPropertyVerification } from '../../src/server/verification/property';
import { getDb } from '../../src/server/db/client';
import { owners, propertyVerifications, userPropertyLinks } from '../../src/server/db/schema';
import { hashCode } from '../../src/server/verification/codes';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('property verification', () => {
  it('queues for manual approval when the address is not on the roster', async () => {
    const result = await requestPropertyVerification(env, 'user-x', '0000 Nonexistent St', 'email');
    expect(result).toEqual({ ok: false, queued: true });
  });

  it('confirm: wrong code increments attempts and returns mismatch; correct code links and consumes', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(owners).values({
      id: 'own-1', fullName: 'Test Owner', address: '1 Test St', addressNormalized: '1 test st',
      unit: null, phone: '+15551234567', email: 't@example.com', status: 'active', notes: null,
      createdAt: now, updatedAt: now,
    });
    await db.insert(propertyVerifications).values({
      id: 'pv-1', userId: 'user-confirm', ownerId: 'own-1', channel: 'email',
      codeHash: await hashCode('123456'), expiresAt: new Date(now.getTime() + 600_000),
      attempts: 0, consumedAt: null, createdAt: now,
    });

    const wrong = await confirmPropertyVerification(env, 'user-confirm', '999999');
    expect(wrong).toEqual({ ok: false, reason: 'mismatch' });
    const [afterWrong] = await db.select().from(propertyVerifications).where(eq(propertyVerifications.id, 'pv-1'));
    expect(afterWrong.attempts).toBe(1);

    const right = await confirmPropertyVerification(env, 'user-confirm', '123456');
    expect(right.ok).toBe(true);
    const links = await db.select().from(userPropertyLinks).where(eq(userPropertyLinks.userId, 'user-confirm'));
    expect(links.length).toBe(1);
    expect(links[0].ownerId).toBe('own-1');
    const [consumed] = await db.select().from(propertyVerifications).where(eq(propertyVerifications.id, 'pv-1'));
    expect(consumed.consumedAt).not.toBeNull();
  });
});
