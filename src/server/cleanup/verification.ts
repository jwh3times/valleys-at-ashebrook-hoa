import { and, inArray, lt, or } from 'drizzle-orm';
import { getDb } from '../db/client';
import { manualApprovalQueue, propertyVerifications } from '../db/schema';

const RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function cleanupVerificationState(
  env: Env,
  now = new Date(),
): Promise<{ verificationRows: number; manualApprovalRows: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * MS_PER_DAY);
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

  return {
    verificationRows: verificationRows.length,
    manualApprovalRows: manualApprovalRows.length,
  };
}
