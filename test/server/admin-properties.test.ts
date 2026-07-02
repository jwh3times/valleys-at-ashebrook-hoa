import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/properties';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin properties', () => {
  it('rejects an unauthenticated GET with 401', async () => {
    const res = await GET({
      request: new Request('http://localhost/api/admin/properties'),
    } as never);
    expect(res.status).toBe(401);
  });
  it('rejects an unauthenticated POST with 401', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/properties', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: '1 St' }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});
