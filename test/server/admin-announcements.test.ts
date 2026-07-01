import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { POST } from '../../src/pages/api/admin/announcements';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin announcements — gate', () => {
  it('rejects an unauthenticated create with 401', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/announcements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'X', body: 'Y', date: '2026-01-01' }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});
