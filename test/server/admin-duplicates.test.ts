import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/duplicates';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin duplicates - gate', () => {
  it('rejects an unauthenticated GET with 401', async () => {
    const res = await GET({
      request: new Request('http://localhost/api/admin/duplicates'),
    } as never);
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated resolve with 401', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/duplicates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve',
          keepId: 'x',
          deleteIds: ['y'],
        }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});
