import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sendEmail, sendSms } from '../auth/senders';
import { findActiveOwnerByAddress } from '../roster/lookup';
import { generateCode, hashCode, verifyCode, MAX_ATTEMPTS, CODE_TTL_MS } from './codes';
import { manualApprovalQueue, propertyVerifications, userPropertyLinks, users } from '../db/schema';

export async function requestPropertyVerification(
  env: Env,
  userId: string,
  address: string,
  channel: 'email' | 'sms',
): Promise<{ ok: true } | { ok: false; queued: true }> {
  const db = getDb(env);
  const owner = await findActiveOwnerByAddress(db, address);
  const now = new Date();
  if (!owner || (channel === 'email' && !owner.email) || (channel === 'sms' && !owner.phone)) {
    await db.insert(manualApprovalQueue).values({
      id: crypto.randomUUID(),
      userId,
      claimedAddress: address,
      reason: owner ? 'no contact on file for channel' : 'address not found',
      status: 'pending',
      createdAt: now,
    });
    return { ok: false, queued: true };
  }
  const code = generateCode();
  await db.insert(propertyVerifications).values({
    id: crypto.randomUUID(),
    userId,
    ownerId: owner.id,
    channel,
    codeHash: await hashCode(code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    attempts: 0,
    consumedAt: null,
    createdAt: now,
  });
  const message = `Your Valleys at Ashebrook verification code is ${code}. It expires in 10 minutes.`;
  if (channel === 'email') await sendEmail(env, owner.email!, 'Your HOA verification code', message);
  else await sendSms(env, owner.phone!, message);
  return { ok: true };
}

export async function confirmPropertyVerification(
  env: Env,
  userId: string,
  code: string,
): Promise<{ ok: boolean; reason?: 'expired' | 'locked' | 'mismatch' }> {
  const db = getDb(env);
  const [pv] = await db
    .select()
    .from(propertyVerifications)
    .where(and(eq(propertyVerifications.userId, userId), isNull(propertyVerifications.consumedAt)))
    .orderBy(propertyVerifications.createdAt);
  if (!pv) return { ok: false, reason: 'mismatch' };
  if (pv.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (pv.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (!(await verifyCode(code, pv.codeHash))) {
    await db
      .update(propertyVerifications)
      .set({ attempts: pv.attempts + 1 })
      .where(eq(propertyVerifications.id, pv.id));
    return { ok: false, reason: 'mismatch' };
  }
  await db
    .update(propertyVerifications)
    .set({ consumedAt: new Date() })
    .where(eq(propertyVerifications.id, pv.id));
  await db.insert(userPropertyLinks).values({
    id: crypto.randomUUID(),
    userId,
    ownerId: pv.ownerId,
    verifiedAt: new Date(),
    method: pv.channel === 'email' ? 'otp_email' : 'otp_sms',
  });
  // Promote to homeowner ONLY if currently a visitor — never downgrade board, never re-touch homeowner.
  await db
    .update(users)
    .set({ role: 'homeowner' })
    .where(and(eq(users.id, userId), eq(users.role, 'visitor')));
  return { ok: true };
}
