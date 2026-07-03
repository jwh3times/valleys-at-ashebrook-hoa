import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST } from '../../src/pages/api/admin/announcements';
import { getDb } from '../../src/server/db/client';
import { announcements } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin announcements — board', () => {
  it('creates an announcement with the given visibility', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/announcements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Notice',
          body: 'Body',
          date: '2026-02-02',
          pinned: true,
          visibility: 'homeowner',
        }),
      }),
    } as never);
    expect(res.status).toBe(201);
    const rows = await getDb(env)
      .select()
      .from(announcements)
      .where(eq(announcements.title, 'Notice'));
    expect(rows.length).toBe(1);
    expect(rows[0].visibility).toBe('homeowner');
    expect(rows[0].pinned).toBe(true);
  });
});
