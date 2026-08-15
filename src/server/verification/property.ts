import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sendEmail, sendSms } from '../auth/senders';
import { SITE_NAME } from '../../lib/site';
import { maskEmail } from '../../lib/format';
import { normalizeName } from '../roster/normalize';
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
import { propertyVerifications, userPropertyLinks, users } from '../db/schema';
import {
  checkPropertyRateLimit,
  recordVerificationSend,
  checkClaimedNames,
  recordClaimedName,
} from './rate-limit';

// The LEGACY backend for /api/verify/request + confirm (#219/D1). Production
// runs `cutover_mode = legacy` until the flip and the roster tables are empty
// until the authoritative backfill, so this keeps the pre-flip fan-out exactly
// as it was: every active owner contact on the channel gets the code. `name`
// is accepted by the route contract but NOT used for matching here — that
// closes only once the derived backend (`src/server/roster/verification.ts`)
// takes over.
//
// #219 also retires the three `manual_approval_queue` auto-enqueue paths this
// function used to write (address not found, no contact on file, every send
// failed): nothing auto-queues anymore (#201). Every internal failure is
// reported as an outcome code so the route can map it to the uniform response
// (D2); the applicant-visible review request is now an explicit action
// (`POST /api/verify/review`).
export type PropertyVerificationOutcome =
  | { ok: true }
  | {
      ok: false;
      outcome: 'not_found' | 'no_contact' | 'send_failed' | 'rate_limited';
    };

export async function requestPropertyVerification(
  env: Env,
  userId: string,
  address: string,
  name: string,
  channel: 'email' | 'sms',
): Promise<PropertyVerificationOutcome> {
  const db = getDb(env);
  const property = await findActivePropertyByAddress(db, address);
  const now = new Date();
  if (!property) return { ok: false, outcome: 'not_found' };

  const prl = await checkPropertyRateLimit(env, property.id);
  if (!prl.ok) return { ok: false, outcome: 'rate_limited' };

  // The distinct-claimed-names cap runs in BOTH modes (D11) even though
  // legacy never matches on the name — it is the roster-walking control, not
  // a matching aid.
  const normalizedName = normalizeName(name);
  if (normalizedName) {
    const namesRl = await checkClaimedNames(
      env,
      property.id,
      userId,
      normalizedName,
    );
    if (!namesRl.ok) return { ok: false, outcome: 'rate_limited' };
    await recordClaimedName(env, property.id, userId, normalizedName);
  }

  const propertyOwners = await getActiveOwnersForProperty(db, property.id);
  const recipients = [
    ...new Set(
      propertyOwners
        .map((o) => (channel === 'email' ? o.email : o.phone))
        .filter((v): v is string => !!v),
    ),
  ];
  if (recipients.length === 0) return { ok: false, outcome: 'no_contact' };

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
    return { ok: false, outcome: 'send_failed' };
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
  // Re-verifying a home the user is already linked to is a no-op link-wise
  // (the (user_id, property_id) unique would otherwise reject the insert).
  await db
    .insert(userPropertyLinks)
    .values({
      id: crypto.randomUUID(),
      userId,
      propertyId: pv.propertyId,
      verifiedAt: new Date(),
      method: pv.channel === 'email' ? 'otp_email' : 'otp_sms',
    })
    .onConflictDoNothing();
  // Promote to homeowner ONLY if currently a visitor — never downgrade board, never re-touch homeowner.
  await db
    .update(users)
    .set({ role: 'homeowner' })
    .where(and(eq(users.id, userId), eq(users.role, 'visitor')));
  return { ok: true };
}
