import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { POST, PATCH, DELETE } from '../../src/pages/api/admin/candidates';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function req(url: string, method: string, body?: unknown) {
  return {
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

describe('candidates admin route — gate', () => {
  const url = 'http://localhost/api/admin/candidates';

  it('rejects an unauthenticated create with 401', async () => {
    expect(
      (await POST(req(url, 'POST', { electionId: 'e1', fullName: 'A. Reyes' })))
        .status,
    ).toBe(401);
  });

  it('rejects an unauthenticated patch with 401', async () => {
    expect(
      (await PATCH(req(url, 'PATCH', { id: 'c1', fullName: 'X' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated delete with 401', async () => {
    expect((await DELETE(req(url, 'DELETE', { id: 'c1' }))).status).toBe(401);
  });
});
