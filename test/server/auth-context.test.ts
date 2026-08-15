import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';

const getSession = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/auth', () => ({
  createAuth: vi.fn(() => ({
    api: { getSession },
  })),
}));

import { getAuthContext } from '../../src/server/authz/context';
import { legacyAuthContext } from '../../src/server/authz/context';

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  getSession.mockReset();
  await db.delete(userPropertyLinks);
  await db.delete(properties);
  await db.delete(users);
});

async function seedUserWithProperties(userRole: string | null) {
  const db = getDb(env);
  await db.insert(users).values({
    id: 'u1',
    name: 'User One',
    email: 'u1@example.com',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: userRole,
  });
  await db.insert(properties).values([
    {
      id: 'active-home',
      address: '1 Main St',
      addressNormalized: '1 main st',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'inactive-home',
      address: '2 Main St',
      addressNormalized: '2 main st',
      status: 'inactive',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  await db.insert(userPropertyLinks).values([
    {
      id: 'l1',
      userId: 'u1',
      propertyId: 'active-home',
      verifiedAt: new Date(),
      method: 'otp_email',
    },
    {
      id: 'l2',
      userId: 'u1',
      propertyId: 'inactive-home',
      verifiedAt: new Date(),
      method: 'otp_email',
    },
  ]);
}

describe('getAuthContext', () => {
  it('uses the session role and still resolves active property ids', async () => {
    await seedUserWithProperties('visitor');
    getSession.mockResolvedValue({
      user: { id: 'u1', role: 'board' },
    });

    const ctx = await getAuthContext(new Request('http://localhost'), env, DAY);

    expect(ctx).toEqual(legacyAuthContext('u1', 'board', ['active-home']));
  });

  it('fails closed to visitor for an invalid session role', async () => {
    await seedUserWithProperties('board');
    getSession.mockResolvedValue({
      user: { id: 'u1', role: 'super-admin' },
    });

    const ctx = await getAuthContext(new Request('http://localhost'), env, DAY);

    expect(ctx?.role).toBe('visitor');
  });
});

describe('the cutover seam', () => {
  // The property phase 3a exists to establish: which MODEL answers is decided
  // by the flag and by nothing else. Same session, same request, same code
  // path — one row changes the answer.

  async function setMode(value: 'legacy' | 'derived') {
    const db = getDb(env);
    await db.delete(cutoverSettings);
    await db
      .insert(cutoverSettings)
      .values({ key: 'cutover_mode', value, updatedAt: new Date() });
  }

  beforeEach(async () => {
    await getDb(env).delete(cutoverSettings);
  });

  it('answers from the legacy roster while the flag is legacy', async () => {
    await seedUserWithProperties('board');
    getSession.mockResolvedValue({ user: { id: 'u1', role: 'board' } });

    const ctx = await getAuthContext(new Request('http://localhost'), env, DAY);

    expect(ctx).toEqual(legacyAuthContext('u1', 'board', ['active-home']));
    expect(ctx?.personId).toBeNull();
  });

  it('answers from the party roster once the flag is derived', async () => {
    // No Person Link exists for this account, so the derived answer is visitor
    // with no capabilities — while legacy would have said board. The two
    // disagreeing here is the point: it proves the flag, not the session,
    // selected the model.
    await seedUserWithProperties('board');
    getSession.mockResolvedValue({ user: { id: 'u1', role: 'board' } });
    await setMode('derived');

    const ctx = await getAuthContext(new Request('http://localhost'), env, DAY);

    expect(ctx?.contentTier).toBe('visitor');
    expect([...(ctx?.capabilities ?? [])]).toEqual([]);
    expect(ctx?.lotIds).toEqual([]);
  });

  it('reverses when the flag goes back to legacy', async () => {
    // The abort path. Nothing is cached, so rolling the flag back restores the
    // previous answer on the very next request with no deploy.
    await seedUserWithProperties('board');
    getSession.mockResolvedValue({ user: { id: 'u1', role: 'board' } });

    await setMode('derived');
    const derived = await getAuthContext(
      new Request('http://localhost'),
      env,
      DAY,
    );
    expect(derived?.contentTier).toBe('visitor');

    await setMode('legacy');
    const back = await getAuthContext(
      new Request('http://localhost'),
      env,
      DAY,
    );
    expect(back?.contentTier).toBe('board');
    expect(back?.lotIds).toEqual(['active-home']);
  });

  it('returns a context rather than null for an authenticated unlinked account', async () => {
    // 403, not 401. An authenticated caller with no Person Link is "signed in
    // and this is not yours", which the gates can only express if the seam
    // hands them a context instead of null.
    await seedUserWithProperties('board');
    getSession.mockResolvedValue({ user: { id: 'u1', role: 'board' } });
    await setMode('derived');

    const ctx = await getAuthContext(new Request('http://localhost'), env, DAY);

    expect(ctx).not.toBeNull();
    expect(ctx?.userId).toBe('u1');
  });
});
