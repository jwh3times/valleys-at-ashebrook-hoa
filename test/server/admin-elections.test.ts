import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/elections';

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

describe('elections admin route — gate', () => {
  const url = 'http://localhost/api/admin/elections';

  it('rejects an unauthenticated read with 401', async () => {
    expect((await GET(req(url, 'GET'))).status).toBe(401);
  });

  it('rejects an unauthenticated create with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            title: '2026 Board Election',
            seats: 2,
            electionDate: '2026-03-01',
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated close with 401', async () => {
    expect(
      (await POST(req(url, 'POST', { action: 'close', id: 'e1' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated void with 401', async () => {
    expect(
      (await POST(req(url, 'POST', { action: 'void', id: 'e1' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated setTallies with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setTallies',
            electionId: 'e1',
            entries: [],
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated setBallots with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setBallots',
            electionId: 'e1',
            entries: [],
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated patch with 401', async () => {
    expect(
      (await PATCH(req(url, 'PATCH', { id: 'e1', title: 'X' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated delete with 401', async () => {
    expect((await DELETE(req(url, 'DELETE', { id: 'e1' }))).status).toBe(401);
  });
});
