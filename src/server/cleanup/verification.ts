import { and, inArray, lt, or } from 'drizzle-orm';
import { getDb } from '../db/client';
import { manualApprovalQueue, propertyVerifications } from '../db/schema';
import {
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
  verificationRows: number;
  manualApprovalRows: number;
  verificationCodeRows: number;
  reviewRequestRows: number;
}> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * MS_PER_DAY);
  const codeCutoff = new Date(now.getTime() - CODE_RETENTION_MS);
  const db = getDb(env);

  const verificationRows = await db
    .delete(propertyVerifications)
    .where(
      or(
        lt(propertyVerifications.consumedAt, cutoff),
        lt(propertyVerifications.expiresAt, cutoff),
      ),
    )
    .returning({ id: propertyVerifications.id });

  const manualApprovalRows = await db
    .delete(manualApprovalQueue)
    .where(
      and(
        inArray(manualApprovalQueue.status, ['approved', 'denied']),
        lt(manualApprovalQueue.createdAt, cutoff),
      ),
    )
    .returning({ id: manualApprovalQueue.id });

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

  return {
    verificationRows: verificationRows.length,
    manualApprovalRows: manualApprovalRows.length,
    verificationCodeRows: verificationCodeRows.length,
    reviewRequestRows: reviewRequestRows.length,
  };
}
