import { describe, it, expect, vi, beforeEach } from 'vitest';

const handle = vi.hoisted(() => vi.fn());
const cleanupVerificationState = vi.hoisted(() => vi.fn());

vi.mock('@astrojs/cloudflare/handler', () => ({
  handle,
}));

vi.mock('../../src/server/cleanup/verification', () => ({
  cleanupVerificationState,
}));

import worker from '../../src/worker';

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('custom Worker entrypoint', () => {
  beforeEach(() => {
    handle.mockReset();
    cleanupVerificationState.mockReset();
  });

  it('delegates fetch requests to the Astro handler', async () => {
    const response = new Response('ok');
    const request = new Request('http://localhost/');
    const env = {} as Env;
    handle.mockResolvedValue(response);

    await expect(worker.fetch(request, env, ctx)).resolves.toBe(response);
    expect(handle).toHaveBeenCalledWith(request, env, ctx);
  });

  it('runs verification cleanup on the scheduled trigger', async () => {
    const env = {} as Env;
    cleanupVerificationState.mockResolvedValue({
      verificationRows: 1,
      manualApprovalRows: 2,
    });

    await worker.scheduled({} as ScheduledController, env, ctx);

    expect(cleanupVerificationState).toHaveBeenCalledWith(env);
  });
});
