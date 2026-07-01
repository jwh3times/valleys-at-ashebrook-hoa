import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { POST, DELETE } from '../../src/pages/api/admin/documents';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin documents — gate', () => {
  it('rejects an unauthenticated upload with 401', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'POST',
      }),
    } as never);
    expect(res.status).toBe(401);
  });
  it('rejects an unauthenticated delete with 401', async () => {
    const res = await DELETE({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'x' }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});
