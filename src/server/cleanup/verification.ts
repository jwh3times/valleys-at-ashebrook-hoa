import { and, inArray, lt, or } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  tenancyInvitations,
  verificationCodes,
  verificationReviewRequests,
} from '../db/roster-schema';

const RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// verification_codes are short-lived operational rows (#219 D4): a pending
// code is only ever useful for its ~10-minute TTL, so a day's grace past
// consumption/expiry is plenty rather than the 30-day retention used for the
// longer-lived queues below.
const CODE_RETENTION_MS = MS_PER_DAY;

export async function cleanupVerificationState(
  env: Env,
  now = new Date(),
): Promise<{
  verificationCodeRows: number;
  reviewRequestRows: number;
  tenancyInvitationRows: number;
}> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * MS_PER_DAY);
  const codeCutoff = new Date(now.getTime() - CODE_RETENTION_MS);
  const db = getDb(env);

  // #219 D4: the pending-code twin of the propertyVerifications sweep above,
  // just on a much shorter retention window (see CODE_RETENTION_MS).
  const verificationCodeRows = await db
    .delete(verificationCodes)
    .where(
      or(
        lt(verificationCodes.consumedAt, codeCutoff),
        lt(verificationCodes.expiresAt, codeCutoff),
      ),
    )
    .returning({ id: verificationCodes.id });

  // #219 D6: mirrors the manualApprovalQueue sweep's constant and shape —
  // only resolved (non-open) rows age out, and open rows are kept forever.
  const reviewRequestRows = await db
    .delete(verificationReviewRequests)
    .where(
      and(
        inArray(verificationReviewRequests.status, ['accepted', 'declined']),
        lt(verificationReviewRequests.resolvedAt, cutoff),
      ),
    )
    .returning({ id: verificationReviewRequests.id });

  // #294 slice 4: a Tenancy invitation lives 14 days. Once it has been
  // expired for the retention window — consumed, superseded or never used —
  // nothing needs it: the claim's Person Verification is the durable record.
  const tenancyInvitationRows = await db
    .delete(tenancyInvitations)
    .where(lt(tenancyInvitations.expiresAt, cutoff))
    .returning({ id: tenancyInvitations.id });

  return {
    verificationCodeRows: verificationCodeRows.length,
    reviewRequestRows: reviewRequestRows.length,
    tenancyInvitationRows: tenancyInvitationRows.length,
  };
}
