import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET } from '../../src/pages/api/admin/members';
import { getDb } from '../../src/server/db/client';
import { manualApprovalQueue, users } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin members GET', () => {
  it('joins the requester email onto each pending queue row', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(users).values({
      id: 'u-q',
      name: 'Queued User',
      email: 'queued@example.com',
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(manualApprovalQueue).values({
      id: 'q-1',
      userId: 'u-q',
      claimedAddress: '1 Test St',
      reason: 'address not found',
      status: 'pending',
      createdAt: now,
    });

    const res = await GET({
      request: new Request('http://localhost/api/admin/members'),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queue: { id: string; email: string | null; claimedAddress: string }[];
    };
    const row = body.queue.find((q) => q.id === 'q-1');
    expect(row).toBeDefined();
    expect(row!.email).toBe('queued@example.com');
    expect(row!.claimedAddress).toBe('1 Test St');
  });
});
