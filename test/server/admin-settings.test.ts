import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { PUT } from '../../src/pages/api/admin/dues';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin settings — gate', () => {
  it('rejects an unauthenticated dues update with 401', async () => {
    const res = await PUT({
      request: new Request('http://localhost/api/admin/dues', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '100' }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});
