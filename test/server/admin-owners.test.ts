import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/owners';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin owners', () => {
  it('rejects an unauthenticated GET with 401', async () => {
    const res = await GET({
      request: new Request('http://localhost/api/admin/owners'),
    } as never);
    expect(res.status).toBe(401);
  });
  it('rejects an unauthenticated POST with 401', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/owners', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: 'X', address: '1 St' }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});
