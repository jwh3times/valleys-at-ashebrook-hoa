import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// Signed-in requester + captcha pass; senders are spies so no real network.
// The caller id is mutable so the two describe blocks below can use distinct
// accounts — sharing one account id would collide on the per-account
// cooldown KV key, which persists for the whole file's run.
const callerState = vi.hoisted(() => ({ userId: 'msguser' }));
vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    callerContext(callerState.userId, 'homeowner', []),
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
import { callerContext } from './caller-context';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { resetRoster, seedRoster } from './dual-fixtures';

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

// ADR 0022 phase 3c (#219): the route contract is unified across both
// backends (D1), and D2's uniform response applies to a successful match too
// — the caller learns nothing beyond "a code may have been sent."

describe('POST /api/verify/request OTP message — derived backend', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(sendEmail).mockResolvedValue(undefined);
    callerState.userId = 'msguser-derived';
    await resetRoster();
    await getDb(env).run(sql.raw('DELETE FROM users'));
    await getDb(env).delete(cutoverSettings);

    await seedRoster({
      lots: [
        {
          id: 'msg-lot',
          owners: [
            {
              id: 'msg-person',
              name: 'Derived Owner',
              email: 'derived@example.com',
            },
          ],
        },
      ],
      accounts: [{ id: 'msguser-derived', role: 'homeowner' }],
    });
  });

  it('matches the Person and sends exactly ONE code to the matched contact', async () => {
    const res = await req({
      address: 'msg-lot Way',
      name: 'Derived Owner',
      channel: 'email',
      turnstileToken: 't',
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(UNIFORM_REQUEST_RESPONSE);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [, to, , message] = (sendEmail as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, string, string, string];
    expect(to).toBe('derived@example.com');
    expect(message).toMatch(/\b\d{6}\b/);
  });
});
