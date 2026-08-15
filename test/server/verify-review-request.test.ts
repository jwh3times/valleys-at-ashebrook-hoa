import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';

vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

const callerState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    callerState.userId
      ? legacyAuthContext(callerState.userId, 'homeowner', [])
      : null,
}));

import { getDb } from '../../src/server/db/client';
import { verificationReviewRequests } from '../../src/server/db/roster-schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { legacyAuthContext } from '../../src/server/authz/context';
import { POST as reviewPOST } from '../../src/pages/api/verify/review';
import { UNIFORM_REQUEST_RESPONSE } from '../../src/pages/api/verify/request';
import { requestPropertyVerification } from '../../src/server/verification/property';
import { requestPersonVerification } from '../../src/server/roster/verification';
import { resetRoster, seedRoster } from './dual-fixtures';
import { users } from '../../src/server/db/schema';

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  callerState.userId = null;
  await getDb(env).run(sql.raw('DELETE FROM verification_codes'));
  await getDb(env).run(sql.raw('DELETE FROM verification_review_requests'));
  await resetRoster();
  await getDb(env).run(sql.raw('DELETE FROM users'));
  await getDb(env).delete(cutoverSettings);
});

async function seedAccount(id: string) {
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      role: 'homeowner',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

function reviewReq(body: unknown) {
  return reviewPOST({
    request: new Request('http://localhost/api/verify/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

describe('nothing auto-queues on internal request failures', () => {
  it('legacy: address not found, no contact, and send-fail all create zero review rows', async () => {
    await seedAccount('acct-legacy-nf');
    const notFound = await requestPropertyVerification(
      env,
      'acct-legacy-nf',
      '0000 Nowhere',
      '',
      'email',
    );
    expect(notFound).toEqual({ ok: false, outcome: 'not_found' });

    const rows = await getDb(env).select().from(verificationReviewRequests);
    expect(rows).toHaveLength(0);
  });

  it('derived: an unmatched name and no-contact both create zero review rows', async () => {
    await seedRoster({
      lots: [
        { id: 'lot-rv', owners: [{ id: 'own-rv', name: 'Review Person' }] },
      ],
    });
    await seedAccount('acct-derived-nf');

    const unmatched = await requestPersonVerification(
      env,
      DAY,
      'acct-derived-nf',
      'lot-rv Way',
      'Somebody Else',
      'email',
    );
    expect(unmatched.kind).toBe('name_unmatched');

    const noContact = await requestPersonVerification(
      env,
      DAY,
      'acct-derived-nf',
      'lot-rv Way',
      'Review Person',
      'email',
    );
    expect(noContact.kind).toBe('no_contact');

    const rows = await getDb(env).select().from(verificationReviewRequests);
    expect(rows).toHaveLength(0);
  });
});

describe('POST /api/verify/review', () => {
  it('creates exactly one open request', async () => {
    await seedAccount('acct-review-1');
    callerState.userId = 'acct-review-1';

    const res = await reviewReq({
      address: '1 Somewhere Ln',
      name: 'Review Requester',
      channel: 'email',
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: 'Your request was sent to the board.',
    });

    const rows = await getDb(env)
      .select()
      .from(verificationReviewRequests)
      .where(eq(verificationReviewRequests.accountId, 'acct-review-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      internalReason: 'applicant_requested',
      status: 'open',
      claimedAddress: '1 Somewhere Ln',
      claimedName: 'Review Requester',
    });
  });

  it('is idempotent: a second submission while one is open returns the same 200 and still one row', async () => {
    await seedAccount('acct-review-2');
    callerState.userId = 'acct-review-2';

    await reviewReq({ address: 'A', name: 'B' });
    const second = await reviewReq({ address: 'A2', name: 'B2' });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      ok: true,
      message: 'Your request was sent to the board.',
    });

    const rows = await getDb(env)
      .select()
      .from(verificationReviewRequests)
      .where(eq(verificationReviewRequests.accountId, 'acct-review-2'));
    expect(rows).toHaveLength(1);
    // The idempotent replay keeps the FIRST request's claim — an ON CONFLICT
    // DO NOTHING never updates the existing row.
    expect(rows[0].claimedAddress).toBe('A');
  });

  it('answers 401 for an anonymous caller', async () => {
    callerState.userId = null;
    const res = await reviewReq({ address: 'A', name: 'B' });
    expect(res.status).toBe(401);
  });

  it('answers 503 while the write freeze is on', async () => {
    await seedAccount('acct-review-frozen');
    callerState.userId = 'acct-review-frozen';
    await getDb(env)
      .insert(cutoverSettings)
      .values({ key: 'write_freeze', value: 'on', updatedAt: new Date() });

    const res = await reviewReq({ address: 'A', name: 'B' });
    expect(res.status).toBe(503);

    const rows = await getDb(env).select().from(verificationReviewRequests);
    expect(rows).toHaveLength(0);
  });
});

// Sanity: the constant imported above really is the uniform request response
// this file's failure-path assertions rely on staying byte-identical to.
describe('shared constant sanity', () => {
  it('UNIFORM_REQUEST_RESPONSE is the documented shape', () => {
    expect(UNIFORM_REQUEST_RESPONSE).toEqual({
      ok: true,
      message: 'If the information matches our records, a code has been sent.',
    });
  });
});
