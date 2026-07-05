import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sendEmail, sendSms } from '../auth/senders';
import { SITE_NAME } from '../../lib/site';
import { maskEmail } from '../../lib/format';
import {
  findActivePropertyByAddress,
  getActiveOwnersForProperty,
} from '../roster/lookup';
import {
  generateCode,
  hashCode,
  verifyCode,
  MAX_ATTEMPTS,
  CODE_TTL_MS,
} from './codes';
import {
  manualApprovalQueue,
  propertyVerifications,
  userPropertyLinks,
  users,
} from '../db/schema';
import { checkPropertyRateLimit, recordVerificationSend } from './rate-limit';

export async function requestPropertyVerification(
  env: Env,
  userId: string,
  address: string,
  channel: 'email' | 'sms',
): Promise<
  { ok: true } | { ok: false; queued: true } | { ok: false; rateLimited: true }
> {
  const db = getDb(env);
  const property = await findActivePropertyByAddress(db, address);
  const now = new Date();
  if (!property) {
    await db.insert(manualApprovalQueue).values({
      id: crypto.randomUUID(),
      userId,
      claimedAddress: address,
      reason: 'address not found',
      status: 'pending',
      createdAt: now,
    });
    return { ok: false, queued: true };
  }

  const propertyOwners = await getActiveOwnersForProperty(db, property.id);
  const recipients = [
    ...new Set(
      propertyOwners
        .map((o) => (channel === 'email' ? o.email : o.phone))
        .filter((v): v is string => !!v),
    ),
  ];
  if (recipients.length === 0) {
    await db.insert(manualApprovalQueue).values({
      id: crypto.randomUUID(),
      userId,
      claimedAddress: address,
      reason: 'no contact on file for channel',
      status: 'pending',
      createdAt: now,
    });
    return { ok: false, queued: true };
  }

  const prl = await checkPropertyRateLimit(env, property.id);
  if (!prl.ok) return { ok: false, rateLimited: true };

  await db
    .delete(propertyVerifications)
    .where(
      and(
        eq(propertyVerifications.userId, userId),
        isNull(propertyVerifications.consumedAt),
      ),
    );
  const code = generateCode();
  await db.insert(propertyVerifications).values({
    id: crypto.randomUUID(),
    userId,
    propertyId: property.id,
    channel,
    codeHash: await hashCode(code, env.BETTER_AUTH_SECRET),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    attempts: 0,
    consumedAt: null,
    createdAt: now,
  });
  // Name the (masked) requester so a recipient can tell a legitimate request
  // from an attacker probing their contact. Code first so SMS length limits
  // never truncate it.
  const [requester] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  const requestedBy = requester?.email
    ? ` Requested by ${maskEmail(requester.email)}.`
    : '';
  const message = `Your Valleys at Ashebrook verification code is ${code}. It expires in 10 minutes.${requestedBy} If you didn't request this, you can ignore this message.`;
  const subject = `Your verification code — ${SITE_NAME}`;
  const results = await Promise.allSettled(
    recipients.map((to) =>
      channel === 'email'
        ? sendEmail(env, to, subject, message)
        : sendSms(env, to, message),
    ),
  );
  if (!results.some((r) => r.status === 'fulfilled')) {
    await db.insert(manualApprovalQueue).values({
      id: crypto.randomUUID(),
      userId,
      claimedAddress: address,
      reason: 'all sends failed',
      status: 'pending',
      createdAt: now,
    });
    return { ok: false, queued: true };
  }
  await recordVerificationSend(env, userId, property.id);
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
    .where(
      and(
        eq(propertyVerifications.userId, userId),
        isNull(propertyVerifications.consumedAt),
      ),
    )
    .orderBy(desc(propertyVerifications.createdAt));
  if (!pv) return { ok: false, reason: 'mismatch' };
  if (pv.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (pv.expiresAt.getTime() < Date.now())
    return { ok: false, reason: 'expired' };
  if (!(await verifyCode(code, pv.codeHash, env.BETTER_AUTH_SECRET))) {
    await db
      .update(propertyVerifications)
      .set({ attempts: sql`${propertyVerifications.attempts} + 1` })
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
    propertyId: pv.propertyId,
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
