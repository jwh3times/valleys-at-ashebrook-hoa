import { cleanupVerificationState } from './cleanup/verification';
import { cleanupSavedReportContent } from './cleanup/reports';
import { formatInvariantRun, runInvariants } from './db/invariants';

/**
 * The body of the daily `0 7 * * *` cron trigger.
 *
 * It lives here rather than in `src/worker.ts` because that file imports
 * Astro's Cloudflare handler, which resolves a build-time virtual module and
 * therefore cannot be imported by the Workers test pool. Keeping the worker
 * entry a thin adapter is what makes this testable at all.
 *
 * The jobs are independent on purpose: one broken cleanup must not hide a
 * roster invariant violation or stop the other retention sweep. Every job
 * always runs, and this throws afterwards if any failed — a partial-success
 * invocation still shows red in the dashboard.
 */
export async function runScheduledJobs(env: Env): Promise<void> {
  const failures: string[] = [];

  try {
    const result = await cleanupVerificationState(env);
    console.log(
      `[cleanup] verification=${result.verificationRows} manual_approval=${result.manualApprovalRows} verification_codes=${result.verificationCodeRows} review_requests=${result.reviewRequestRows}`,
    );
  } catch (err) {
    console.error('[cleanup] failed', err);
    failures.push('cleanup');
  }

  try {
    const result = await cleanupSavedReportContent(env);
    console.log(`[report-retention] reports=${result.reportRows}`);
  } catch (err) {
    console.error('[report-retention] failed', err);
    failures.push('report-retention');
  }

  // ADR 0022 drift check (#240, per #206: the checks that gate a migration are
  // exactly the checks that catch drift afterwards). Operator-facing and
  // IDs-and-codes only. A violation is reported in the logs and in the
  // invocation's failure, never stored — a real violation re-fires every day
  // until it is fixed, so detection needs no durable record of its own.
  try {
    const run = await runInvariants(env);
    for (const line of formatInvariantRun(run)) {
      if (run.healthy) console.log(line);
      else console.error(line);
    }
    if (!run.healthy) failures.push('invariants');
  } catch (err) {
    console.error('[invariants] failed', err);
    failures.push('invariants');
  }

  if (failures.length > 0)
    throw new Error(`scheduled job failed: ${failures.join(', ')}`);
}
