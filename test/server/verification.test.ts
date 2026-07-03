import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import {
  requestPropertyVerification,
  confirmPropertyVerification,
} from '../../src/server/verification/property';
import { sendEmail, sendSms } from '../../src/server/auth/senders';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  owners,
  propertyVerifications,
  userPropertyLinks,
  manualApprovalQueue,
} from '../../src/server/db/schema';
import { hashCode } from '../../src/server/verification/codes';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(() => {
  // Reset call history AND re-establish the resolved default for both senders.
  // clearAllMocks() clears history but not the implementation, so a
  // mockRejectedValue from one test would otherwise leak into later tests.
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue(undefined);
  vi.mocked(sendSms).mockResolvedValue(undefined);
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
      codeHash: await hashCode('123456', env.BETTER_AUTH_SECRET),
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
      codeHash: await hashCode('111111', env.BETTER_AUTH_SECRET),
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
      codeHash: await hashCode('654321', env.BETTER_AUTH_SECRET),
      expiresAt: new Date(base.getTime() + 600_000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(base.getTime() + 60_000),
    });
    const res = await confirmPropertyVerification(env, 'user-multi', '654321');
    expect(res.ok).toBe(true);
  });

  it('fans a verification code out to every distinct sms contact on the home, deduped', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(properties).values({
      id: 'prop-fan',
      address: '9 Fan St',
      addressNormalized: '9 fan st',
      unit: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(owners).values([
      {
        id: 'own-fan-1',
        propertyId: 'prop-fan',
        fullName: 'Owner One',
        phone: '+19195550001',
        email: null,
        status: 'active',
        notes: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'own-fan-2',
        propertyId: 'prop-fan',
        fullName: 'Owner Two',
        phone: '+19195550002',
        email: null,
        status: 'active',
        notes: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'own-fan-3',
        propertyId: 'prop-fan',
        fullName: 'Owner Three (shares phone with Owner One)',
        phone: '+19195550001',
        email: null,
        status: 'active',
        notes: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await requestPropertyVerification(
      env,
      'user-fan',
      '9 Fan St',
      'sms',
    );
    expect(res).toEqual({ ok: true });
    expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(2);
    const calledNumbers = new Set(
      vi.mocked(sendSms).mock.calls.map(([, to]) => to),
    );
    expect(calledNumbers).toEqual(new Set(['+19195550001', '+19195550002']));

    const rows = await db
      .select()
      .from(propertyVerifications)
      .where(eq(propertyVerifications.userId, 'user-fan'));
    expect(rows).toHaveLength(1);
    expect(rows[0].propertyId).toBe('prop-fan');
  });

  it('queues manual approval when the chosen channel has no contacts', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(properties).values({
      id: 'prop-noemail',
      address: '10 NoEmail St',
      addressNormalized: '10 noemail st',
      unit: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(owners).values({
      id: 'own-noemail',
      propertyId: 'prop-noemail',
      fullName: 'No Email',
      phone: '+19195550003',
      email: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    const res = await requestPropertyVerification(
      env,
      'user-noemail',
      '10 NoEmail St',
      'email',
    );
    expect(res).toEqual({ ok: false, queued: true });
    const rows = await db
      .select()
      .from(manualApprovalQueue)
      .where(eq(manualApprovalQueue.userId, 'user-noemail'));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('no contact on file for channel');
  });

  it('queues manual approval when every send fails', async () => {
    const db = getDb(env);
    const now = new Date();
    vi.mocked(sendSms).mockRejectedValue(new Error('boom'));
    await db.insert(properties).values({
      id: 'prop-allfail',
      address: '11 AllFail St',
      addressNormalized: '11 allfail st',
      unit: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(owners).values({
      id: 'own-allfail',
      propertyId: 'prop-allfail',
      fullName: 'All Fail',
      phone: '+19195550004',
      email: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    const res = await requestPropertyVerification(
      env,
      'user-allfail',
      '11 AllFail St',
      'sms',
    );
    expect(res).toEqual({ ok: false, queued: true });
    expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1);
    const rows = await db
      .select()
      .from(manualApprovalQueue)
      .where(eq(manualApprovalQueue.userId, 'user-allfail'));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('all sends failed');
  });
});
