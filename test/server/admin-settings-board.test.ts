import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', ownerIds: [] }),
}));

import { PUT } from '../../src/pages/api/admin/dues';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin dues — board', () => {
  it('upserts the dues settings singleton', async () => {
    const res = await PUT({
      request: new Request('http://localhost/api/admin/dues', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '250', notes: 'annual' }),
      }),
    } as never);
    expect(res.status).toBe(204);
    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'dues'));
    expect(JSON.parse(row.value)).toMatchObject({
      amount: '250',
      notes: 'annual',
    });
  });
});
