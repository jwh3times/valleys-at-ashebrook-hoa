import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  requestPropertyVerification,
  confirmPropertyVerification,
} from '../../src/server/verification/property';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  owners,
  propertyVerifications,
  userPropertyLinks,
} from '../../src/server/db/schema';
import { hashCode } from '../../src/server/verification/codes';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('property verification', () => {
  it('queues for manual approval when the address is not on the roster', async () => {
    const result = await requestPropertyVerification(
      env,
      'user-x',
      '0000 Nonexistent St',
      'email',
    );
    expect(result).toEqual({ ok: false, queued: true });
  });

  it('confirm: wrong code increments attempts; correct code links the property and consumes', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(properties).values({
      id: 'prop-1',
      address: '1 Test St',
      addressNormalized: '1 test st',
      unit: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(owners).values({
      id: 'own-1',
      propertyId: 'prop-1',
      fullName: 'Test Owner',
      phone: '+15551234567',
      email: 't@example.com',
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(propertyVerifications).values({
      id: 'pv-1',
      userId: 'user-confirm',
      propertyId: 'prop-1',
      channel: 'email',
      codeHash: await hashCode('123456'),
      expiresAt: new Date(now.getTime() + 600_000),
      attempts: 0,
      consumedAt: null,
      createdAt: now,
    });

    const wrong = await confirmPropertyVerification(
      env,
      'user-confirm',
      '999999',
    );
    expect(wrong).toEqual({ ok: false, reason: 'mismatch' });
    const [afterWrong] = await db
      .select()
      .from(propertyVerifications)
      .where(eq(propertyVerifications.id, 'pv-1'));
    expect(afterWrong.attempts).toBe(1);

    const right = await confirmPropertyVerification(
      env,
      'user-confirm',
      '123456',
    );
    expect(right.ok).toBe(true);
    const links = await db
      .select()
      .from(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, 'user-confirm'));
    expect(links.length).toBe(1);
    expect(links[0].propertyId).toBe('prop-1');
    const [consumed] = await db
      .select()
      .from(propertyVerifications)
      .where(eq(propertyVerifications.id, 'pv-1'));
    expect(consumed.consumedAt).not.toBeNull();
  });

  it('confirm selects the newest pending code when multiple exist', async () => {
    const db = getDb(env);
    const base = new Date();
    await db.insert(propertyVerifications).values({
      id: 'pv-old',
      userId: 'user-multi',
      propertyId: 'prop-1',
      channel: 'email',
      codeHash: await hashCode('111111'),
      expiresAt: new Date(base.getTime() + 600_000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(base.getTime() - 60_000),
    });
    await db.insert(propertyVerifications).values({
      id: 'pv-new',
      userId: 'user-multi',
      propertyId: 'prop-1',
      channel: 'email',
      codeHash: await hashCode('654321'),
      expiresAt: new Date(base.getTime() + 600_000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(base.getTime() + 60_000),
    });
    const res = await confirmPropertyVerification(env, 'user-multi', '654321');
    expect(res.ok).toBe(true);
  });
});
