import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../src/server/auth';

vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// Invalid input reaches the limiter without doing expensive password hashing.
function attempt(ip: string, path = 'sign-in/email') {
  // Separate instances must share the same database bucket.
  const auth = createAuth({ ...env }, undefined, 'http://localhost:4321');
  return auth.handler(
    new Request(`http://localhost:4321/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: '{}',
    }),
  );
}

describe('D1 auth rate limiting', () => {
  it('allows exactly three concurrent attempts on a new bucket', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => attempt('192.0.2.10')),
    );
    expect(responses.filter((r) => r.status === 400)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(9);
    for (const response of responses.filter((r) => r.status === 429)) {
      expect(Number(response.headers.get('x-retry-after'))).toBeGreaterThan(0);
    }
    expect(
      await env.DATABASE.prepare('SELECT count FROM rate_limits').first(
        'count',
      ),
    ).toBe(3);
  });

  it('keeps IPs and endpoint buckets independent', async () => {
    for (let i = 0; i < 3; i++)
      expect((await attempt('192.0.2.20')).status).toBe(400);
    expect((await attempt('192.0.2.20')).status).toBe(429);
    expect((await attempt('192.0.2.21')).status).toBe(400);
    expect((await attempt('192.0.2.20', 'request-password-reset')).status).toBe(
      400,
    );
  });

  it('admits only three concurrent attempts when an exhausted window expires', async () => {
    for (let i = 0; i < 3; i++) await attempt('192.0.2.30');
    await env.DATABASE.prepare('UPDATE rate_limits SET last_request = ?')
      .bind(Date.now() - 61_000)
      .run();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => attempt('192.0.2.30')),
    );
    expect(responses.filter((r) => r.status === 400)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(9);
  });

  it('throttles reset and verification email requests at three per minute', async () => {
    for (const path of ['request-password-reset', 'send-verification-email']) {
      for (let i = 0; i < 3; i++)
        expect((await attempt('192.0.2.40', path)).status).toBe(400);
      const response = await attempt('192.0.2.40', path);
      expect(response.status).toBe(429);
      expect(Number(response.headers.get('x-retry-after'))).toBeGreaterThan(10);
    }
  });
});
