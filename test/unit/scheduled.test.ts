import { describe, it, expect, vi, beforeEach } from 'vitest';

const cleanupVerificationState = vi.hoisted(() => vi.fn());
const cleanupSavedReportContent = vi.hoisted(() => vi.fn());
const runInvariants = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/cleanup/verification', () => ({
  cleanupVerificationState,
}));

vi.mock('../../src/server/cleanup/reports', () => ({
  cleanupSavedReportContent,
}));

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
  verificationRows: 1,
  manualApprovalRows: 2,
  verificationCodeRows: 3,
  reviewRequestRows: 4,
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

describe('the daily scheduled jobs', () => {
  beforeEach(() => {
    cleanupVerificationState.mockReset();
    cleanupSavedReportContent.mockReset();
    cleanupSavedReportContent.mockResolvedValue({ reportRows: 5 });
    runInvariants.mockReset();
    vi.restoreAllMocks();
  });

  it('runs every job and completes quietly when all are clean', async () => {
    cleanupVerificationState.mockResolvedValue(CLEAN_SWEEP);
    runInvariants.mockResolvedValue(run());

    await expect(runScheduledJobs(env)).resolves.toBeUndefined();

    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
    expect(cleanupSavedReportContent).toHaveBeenCalledWith(env);
    expect(runInvariants).toHaveBeenCalledWith(env);
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
