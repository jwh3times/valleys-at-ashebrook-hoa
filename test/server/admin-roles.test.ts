import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { POST as rolesPost } from '../../src/pages/api/admin/roles';
import { GET as membersGet } from '../../src/pages/api/admin/members';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin members + roles', () => {
  it('rejects unauthenticated role grant with 401', async () => {
    const res = await rolesPost({
      request: new Request('http://localhost/api/admin/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'u', role: 'board', action: 'grant' }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
  it('rejects unauthenticated members list with 401', async () => {
    const res = await membersGet({ request: new Request('http://localhost/api/admin/members') } as never);
    expect(res.status).toBe(401);
  });
});
