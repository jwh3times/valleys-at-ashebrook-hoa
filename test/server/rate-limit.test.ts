import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  checkUserRateLimit,
  checkPropertyRateLimit,
  setCooldown,
  recordVerificationSend,
  DAILY_LIMIT,
} from '../../src/server/verification/rate-limit';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('verification rate limiting', () => {
  it('allows a fresh user', async () => {
    expect(await checkUserRateLimit(env, 'rl-fresh')).toEqual({ ok: true });
  });

  it('blocks with cooldown after setCooldown', async () => {
    await setCooldown(env, 'rl-cool');
    expect(await checkUserRateLimit(env, 'rl-cool')).toEqual({
      ok: false,
      reason: 'cooldown',
    });
  });

  it('blocks a user after DAILY_LIMIT sends', async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) {
      await recordVerificationSend(env, 'rl-day', `prop-${i}`);
    }
    // A distinct check that ignores the cooldown key: use a user with only day counts.
    const res = await checkUserRateLimit(env, 'rl-day');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('daily');
  });

  it('blocks a property after DAILY_LIMIT sends', async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) {
      await recordVerificationSend(env, `u-${i}`, 'prop-hot');
    }
    const res = await checkPropertyRateLimit(env, 'prop-hot');
    expect(res.ok).toBe(false);
  });
});
