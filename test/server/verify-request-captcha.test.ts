import { describe, it, expect, vi } from 'vitest';

const turnstileState = vi.hoisted(() => ({
  valid: false,
  tokens: [] as Array<string | undefined>,
}));

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({
    userId: 'captcha-user',
    role: 'homeowner',
    propertyIds: [],
  }),
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
