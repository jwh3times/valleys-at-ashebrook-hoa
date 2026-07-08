import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';

const getSession = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/auth', () => ({
  createAuth: vi.fn(() => ({
    api: { getSession },
  })),
}));

import { getAuthContext } from '../../src/server/authz/context';

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

    const ctx = await getAuthContext(new Request('http://localhost'), env);

    expect(ctx).toEqual({
      userId: 'u1',
      role: 'board',
      propertyIds: ['active-home'],
    });
  });

  it('fails closed to visitor for an invalid session role', async () => {
    await seedUserWithProperties('board');
    getSession.mockResolvedValue({
      user: { id: 'u1', role: 'super-admin' },
    });

    const ctx = await getAuthContext(new Request('http://localhost'), env);

    expect(ctx?.role).toBe('visitor');
  });
});
