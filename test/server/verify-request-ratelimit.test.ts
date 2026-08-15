import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Signed-in user + captcha pass; senders are inert so no real network.
// (vi.mock calls are hoisted above the imports below by Vitest.)
vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('rluser', 'homeowner', []),
}));
vi.mock('../../src/server/authz/turnstile', () => ({
  verifyTurnstile: async () => true,
}));
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import {
  POST,
  UNIFORM_REQUEST_RESPONSE,
} from '../../src/pages/api/verify/request';
import { sendEmail } from '../../src/server/auth/senders';
import { getDb } from '../../src/server/db/client';
import { properties, owners, users } from '../../src/server/db/schema';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const now = new Date();
  await getDb(env).insert(properties).values({
    id: 'rl-prop',
    address: '5 Rate St',
    addressNormalized: '5 rate st',
    unit: null,
    status: 'active',
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  await getDb(env).insert(users).values({
    id: 'rluser',
    name: 'Rate User',
    email: 'rate-user@example.com',
    emailVerified: true,
    role: 'homeowner',
    createdAt: now,
    updatedAt: now,
  });
  await getDb(env).insert(owners).values({
    id: 'rl-own',
    propertyId: 'rl-prop',
    fullName: 'Rate Owner',
    phone: null,
    email: 'rate@example.com',
    status: 'active',
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
});

function req() {
  return POST({
    request: new Request('http://localhost/api/verify/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: '5 Rate St',
        name: '',
        channel: 'email',
        turnstileToken: 't',
      }),
    }),
  } as never);
}

// ADR 0022 phase 3c (#219/D2): rate-limited paths no longer 429 — they
// converge on the SAME uniform response as everything else on this route.
// The only observable difference the cooldown makes is that the retry sends
// nothing.
describe('POST /api/verify/request rate limiting', () => {
  it('sends the first request then answers the uniform response with no further send on the immediate retry (cooldown)', async () => {
    const first = await req();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual(UNIFORM_REQUEST_RESPONSE);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);

    const second = await req();
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual(UNIFORM_REQUEST_RESPONSE);
    // Still just the one send from the first request — the cooldown blocked
    // the retry from reaching the backend at all.
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
  });
});
