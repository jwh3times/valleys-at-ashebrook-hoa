import { describe, it, expect, vi, beforeEach } from 'vitest';

const cleanupVerificationState = vi.hoisted(() => vi.fn());
const cleanupSavedReportContent = vi.hoisted(() => vi.fn());
const runInvariants = vi.hoisted(() => vi.fn());
const driveKeepalive = vi.hoisted(() => vi.fn());
const sweepR2Orphans = vi.hoisted(() => vi.fn());
const reconcilePayments = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/cleanup/verification', () => ({
  cleanupVerificationState,
}));

vi.mock('../../src/server/cleanup/reports', () => ({
  cleanupSavedReportContent,
}));

vi.mock('../../src/server/drive/keepalive', () => ({ driveKeepalive }));

vi.mock('../../src/server/documents/sweep', () => ({ sweepR2Orphans }));

vi.mock('../../src/server/payments/reconcile', () => ({ reconcilePayments }));

vi.mock('../../src/server/db/invariants', async (importOriginal) => ({
  // formatInvariantRun is pure and worth exercising for real — the log lines
  // are the whole output of a red run, and a mock would assert nothing about
  // what an operator actually sees.
  ...(await importOriginal<typeof import('../../src/server/db/invariants')>()),
  runInvariants,
}));

import { runScheduledJobs } from '../../src/server/scheduled';
import type { InvariantRun } from '../../src/server/db/invariants';

const env = {} as Env;

const CLEAN_SWEEP = {
  verificationCodeRows: 3,
  reviewRequestRows: 4,
  tenancyInvitationRows: 2,
};

function run(overrides: Partial<InvariantRun> = {}): InvariantRun {
  return {
    results: [],
    ran: 17,
    pending: 0,
    violated: 0,
    errored: 0,
    healthy: true,
    ...overrides,
  };
}

const VIOLATED = run({
  results: [
    {
      name: 'ownership_overlap',
      meaning: 'two overlapping ownerships rows share owner_party_id + lot_id',
      status: 'violated',
      rowCount: 1,
      sample: [{ a_id: 'o1', b_id: 'o2' }],
    },
  ],
  violated: 1,
  healthy: false,
});

const RECONCILED = {
  skipped: null,
  listed: 2,
  eventListFailed: false,
  pulled: 3,
  failedPulls: [],
  stalePending: [],
};

const NO_ORPHANS = {
  mode: 'report-only',
  documents: [],
  twins: [],
  deleted: 0,
};

describe('the daily scheduled jobs', () => {
  beforeEach(() => {
    cleanupVerificationState.mockReset();
    cleanupSavedReportContent.mockReset();
    cleanupSavedReportContent.mockResolvedValue({ reportRows: 5 });
    runInvariants.mockReset();
    driveKeepalive.mockReset();
    driveKeepalive.mockResolvedValue('skipped');
    sweepR2Orphans.mockReset();
    sweepR2Orphans.mockResolvedValue(NO_ORPHANS);
    reconcilePayments.mockReset();
    reconcilePayments.mockResolvedValue(RECONCILED);
    vi.restoreAllMocks();
  });

  it('runs every job and completes quietly when all are clean', async () => {
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());

    await expect(runScheduledJobs(env)).resolves.toBeUndefined();

    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
    expect(cleanupSavedReportContent).toHaveBeenCalledWith(env);
    expect(runInvariants).toHaveBeenCalledWith(env);
    expect(driveKeepalive).toHaveBeenCalledWith(env);
    expect(sweepR2Orphans).toHaveBeenCalledWith(env);
    expect(reconcilePayments).toHaveBeenCalledWith(env);
  });

  it('still runs the other jobs when payment reconciliation throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    reconcilePayments.mockRejectedValue(new Error('D1 unavailable'));

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: payments-reconcile',
    );
    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
    expect(cleanupSavedReportContent).toHaveBeenCalledWith(env);
    expect(runInvariants).toHaveBeenCalledWith(env);
    expect(driveKeepalive).toHaveBeenCalledWith(env);
    expect(sweepR2Orphans).toHaveBeenCalledWith(env);
  });

  it('still reconciles payments when the other jobs fail', async () => {
    // A provider outage must not hide an invariant violation, and the reverse.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockRejectedValue(new Error('D1 unavailable'));
    runInvariants.mockResolvedValue(VIOLATED);
    sweepR2Orphans.mockRejectedValue(new Error('R2 unavailable'));

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: cleanup, invariants, r2-orphan-sweep',
    );
    expect(reconcilePayments).toHaveBeenCalledWith(env);
  });

  it('logs reconciliation counts and payment ids, and nothing else', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    reconcilePayments.mockResolvedValue({
      ...RECONCILED,
      stalePending: ['pay-1', 'pay-2'],
    });

    await expect(runScheduledJobs(env)).resolves.toBeUndefined();
    const logged = log.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith('[payments-reconcile]'));
    expect(logged).toEqual([
      '[payments-reconcile] 2 listed fact(s), 3 payment(s) pulled, 0 failed pull(s), 2 newly stale pending',
      '[payments-reconcile] stale pending: pay-1, pay-2',
    ]);
  });

  it('fails the run when a pull or the event list failed, naming the payments', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    reconcilePayments.mockResolvedValue({
      ...RECONCILED,
      eventListFailed: true,
      failedPulls: ['pay-3'],
    });

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: payments-reconcile',
    );
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        '[payments-reconcile] the provider event list was not recorded; the cursor did not move',
        '[payments-reconcile] failed pulls: pay-3',
      ]),
    );
  });

  it('fails the run when only the event list failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    reconcilePayments.mockResolvedValue({
      ...RECONCILED,
      eventListFailed: true,
    });

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: payments-reconcile',
    );
  });

  it('says nothing about payments with no provider configured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    reconcilePayments.mockResolvedValue({
      ...RECONCILED,
      skipped: 'unconfigured',
    });

    await expect(runScheduledJobs(env)).resolves.toBeUndefined();
    expect(reconcilePayments).toHaveBeenCalledWith(env);
    expect(
      log.mock.calls.filter((c) =>
        String(c[0]).startsWith('[payments-reconcile]'),
      ),
    ).toEqual([]);
  });

  it('logs a skip for the write freeze without failing the run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    reconcilePayments.mockResolvedValue({ ...RECONCILED, skipped: 'frozen' });

    await expect(runScheduledJobs(env)).resolves.toBeUndefined();
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(
      '[payments-reconcile] skipped: the write freeze is on',
    );
  });

  it('still runs the other jobs when the R2 orphan sweep fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    sweepR2Orphans.mockRejectedValue(
      new Error('300 orphans exceed the sanity threshold of 200'),
    );

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: r2-orphan-sweep',
    );
    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
    expect(cleanupSavedReportContent).toHaveBeenCalledWith(env);
    expect(runInvariants).toHaveBeenCalledWith(env);
    expect(driveKeepalive).toHaveBeenCalledWith(env);
  });

  it('fails the run past the sanity threshold, still logging the ids', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    sweepR2Orphans.mockResolvedValue({
      mode: 'over-threshold',
      documents: ['d-1'],
      twins: [],
      deleted: 0,
    });

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: r2-orphan-sweep',
    );
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(
      '[r2-orphan-sweep] orphaned files: d-1',
    );
  });

  it('logs the orphan report by document id, without failing the run', async () => {
    // Ids only: a key ends in the filename, and a board filename can name a
    // resident.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    sweepR2Orphans.mockResolvedValue({
      mode: 'report-only',
      documents: ['d-1'],
      twins: ['t-1', 't-2'],
      deleted: 0,
    });

    await expect(runScheduledJobs(env)).resolves.toBeUndefined();
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        '[r2-orphan-sweep] report-only: 1 orphaned file(s), 2 orphaned twin(s), 0 deleted',
        '[r2-orphan-sweep] orphaned files: d-1',
        '[r2-orphan-sweep] orphaned twins: t-1, t-2',
      ]),
    );
  });

  it('still runs the other jobs when the Drive keepalive fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    driveKeepalive.mockRejectedValue(new Error('Google answered 503'));

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: drive-keepalive',
    );
    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
    expect(cleanupSavedReportContent).toHaveBeenCalledWith(env);
    expect(runInvariants).toHaveBeenCalledWith(env);
  });

  it('logs a broken Drive connection without failing the run', async () => {
    // Broken is a fact Google decided, for a System Administrator to fix by
    // reconnecting; it is not the job failing (spec 2026-10-18 decision 1).
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());
    driveKeepalive.mockResolvedValue('broken');

    await expect(runScheduledJobs(env)).resolves.toBeUndefined();
    expect(error.mock.calls.map((c) => String(c[0]))).toContain(
      '[drive-keepalive] the Drive connection is broken; a System Administrator must reconnect it',
    );
  });

  it('still checks invariants when the cleanup sweep fails', async () => {
    // The independence that matters: a retention sweep breaking must not be
    // what hides a roster invariant violation.
    cleanupVerificationState.mockRejectedValue(new Error('D1 unavailable'));
    runInvariants.mockResolvedValue(run());

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: cleanup',
    );
    expect(runInvariants).toHaveBeenCalledWith(env);
  });

  it('still sweeps when an invariant is violated', async () => {
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(VIOLATED);

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: invariants',
    );
    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
    expect(cleanupSavedReportContent).toHaveBeenCalledWith(env);
  });

  it('still runs the other jobs when report retention fails', async () => {
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    cleanupSavedReportContent.mockRejectedValue(new Error('D1 unavailable'));
    runInvariants.mockResolvedValue(run());

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: report-retention',
    );
    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
    expect(runInvariants).toHaveBeenCalledWith(env);
  });

  it('names both failures when two jobs fail', async () => {
    cleanupVerificationState.mockRejectedValue(new Error('D1 unavailable'));
    runInvariants.mockResolvedValue(VIOLATED);

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: cleanup, invariants',
    );
  });

  it('fails the invocation when the invariant run itself throws', async () => {
    // A check that could not run has proven nothing. Reporting green here
    // would be the one failure mode worse than a violation.
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockRejectedValue(new Error('no such table: parties'));

    await expect(runScheduledJobs(env)).rejects.toThrow(
      'scheduled job failed: invariants',
    );
  });

  it('logs a violation to the error channel with its rows', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(VIOLATED);

    await expect(runScheduledJobs(env)).rejects.toThrow();

    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(
      '[invariants] VIOLATED ownership_overlap — 1 row(s): two overlapping ownerships rows share owner_party_id + lot_id',
    );
    expect(logged).toContain('[invariants]   {"a_id":"o1","b_id":"o2"}');
  });

  it('logs a healthy run to the log channel, not the error channel', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());

    await runScheduledJobs(env);

    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(
      '[invariants] 17 checks run, 0 pending, 0 violated, 0 errored',
    );
  });
});
