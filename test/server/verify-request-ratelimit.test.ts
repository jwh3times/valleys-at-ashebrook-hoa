import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Signed-in user + captcha pass; senders are inert so no real network.
// (vi.mock calls are hoisted above the imports below by Vitest.)
vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({
    userId: 'rluser',
    role: 'homeowner',
    propertyIds: [],
  }),
}));
vi.mock('../../src/server/authz/turnstile', () => ({
  verifyTurnstile: async () => true,
}));
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '../../src/pages/api/verify/request';
import { getDb } from '../../src/server/db/client';
import { properties, owners } from '../../src/server/db/schema';

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
        channel: 'email',
        turnstileToken: 't',
      }),
    }),
  } as never);
}

describe('POST /api/verify/request rate limiting', () => {
  it('sends the first request then 429s the immediate retry (cooldown)', async () => {
    const first = await req();
    expect(first.status).toBe(200);
    const second = await req();
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      rateLimited?: boolean;
      message?: string;
    };
    expect(body.rateLimited).toBe(true);
    expect(typeof body.message).toBe('string');
  });
});
