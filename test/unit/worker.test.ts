import { describe, it, expect, vi, beforeEach } from 'vitest';

const handle = vi.hoisted(() => vi.fn());
const runScheduledJobs = vi.hoisted(() => vi.fn());

vi.mock('@astrojs/cloudflare/handler', () => ({
  handle,
}));

vi.mock('../../src/server/scheduled', () => ({
  runScheduledJobs,
}));

import worker from '../../src/worker';

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// The entry point is deliberately a thin adapter: the jobs it triggers live
// in modules the Workers test pool can import, which `src/worker.ts` itself is
// not (it pulls Astro's build-time virtual config). So this file asserts
// delegation only — `scheduled.test.ts` covers what the cron actually does.
describe('custom Worker entrypoint', () => {
  beforeEach(() => {
    handle.mockReset();
    runScheduledJobs.mockReset();
  });

  it('delegates fetch requests to the Astro handler', async () => {
    const response = new Response('ok');
    const request = new Request('http://localhost/');
    const env = {} as Env;
    handle.mockResolvedValue(response);

    await expect(worker.fetch(request, env, ctx)).resolves.toBe(response);
    expect(handle).toHaveBeenCalledWith(request, env, ctx);
  });

  it('delegates the scheduled trigger to the scheduled jobs', async () => {
    const env = {} as Env;
    runScheduledJobs.mockResolvedValue(undefined);

    await worker.scheduled({} as ScheduledController, env, ctx);

    expect(runScheduledJobs).toHaveBeenCalledWith(env);
  });

  it('lets a failed scheduled job fail the invocation', async () => {
    runScheduledJobs.mockRejectedValue(new Error('scheduled job failed: x'));

    await expect(
      worker.scheduled({} as ScheduledController, {} as Env, ctx),
    ).rejects.toThrow('scheduled job failed: x');
  });
});
