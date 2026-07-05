import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Signed-in requester + captcha pass; senders are spies so no real network.
vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({
    userId: 'msguser',
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
import { sendEmail } from '../../src/server/auth/senders';
import { getDb } from '../../src/server/db/client';
import { properties, owners, users } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const now = new Date();
  await getDb(env).insert(users).values({
    id: 'msguser',
    name: 'Req Uester',
    email: 'requester@example.com',
    role: 'homeowner',
  });
  await getDb(env).insert(properties).values({
    id: 'msg-prop',
    address: '9 Message Ln',
    addressNormalized: '9 message ln',
    unit: null,
    status: 'active',
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  await getDb(env).insert(owners).values({
    id: 'msg-own',
    propertyId: 'msg-prop',
    fullName: 'Message Owner',
    phone: null,
    email: 'owner@example.com',
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
        address: '9 Message Ln',
        channel: 'email',
        turnstileToken: 't',
      }),
    }),
  } as never);
}

describe('POST /api/verify/request OTP message', () => {
  it('names the masked requester and still carries the code', async () => {
    const res = await req();
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalled();
    const message = (sendEmail as ReturnType<typeof vi.fn>).mock
      .calls[0][3] as string;
    // The 6-digit code is present...
    expect(message).toMatch(/\b\d{6}\b/);
    // ...and the requester is named, masked (never the full address).
    expect(message).toContain('r***@example.com');
    expect(message).not.toContain('requester@example.com');
  });
});
