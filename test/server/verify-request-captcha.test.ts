import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll } from 'vitest';

const turnstileState = vi.hoisted(() => ({
  valid: false,
  tokens: [] as Array<string | undefined>,
}));

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    legacyAuthContext('captcha-user', 'homeowner', []),
}));
vi.mock('../../src/server/authz/turnstile', () => ({
  verifyTurnstile: async (_env: unknown, token?: string) => {
    turnstileState.tokens.push(token);
    return turnstileState.valid;
  },
}));
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '../../src/pages/api/verify/request';
import { legacyAuthContext } from '../../src/server/authz/context';

// This route reads the write-freeze setting before anything else, and that read
// fails closed — so it needs a migrated database even though every other
// dependency here is mocked. Without the migrations the missing
// `cutover_settings` table reads as "frozen" and every case below answers 503.
beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function req(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/verify/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

describe('POST /api/verify/request captcha errors', () => {
  it('returns JSON 400 when the Turnstile token is missing', async () => {
    turnstileState.valid = false;
    turnstileState.tokens = [];

    const res = await req({
      address: '1 Test St',
      channel: 'email',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/captcha/i),
    });
    expect(turnstileState.tokens).toEqual([undefined]);
  });

  it('returns JSON 400 when Turnstile rejects the token', async () => {
    turnstileState.valid = false;
    turnstileState.tokens = [];

    const res = await req({
      address: '1 Test St',
      channel: 'email',
      turnstileToken: 'invalid-token',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/captcha/i),
    });
    expect(turnstileState.tokens).toEqual(['invalid-token']);
  });
});
