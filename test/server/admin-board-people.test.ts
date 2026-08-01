import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  GET,
  POST,
  PATCH,
  DELETE,
} from '../../src/pages/api/admin/board-people';
import {
  POST as termPost,
  PATCH as termPatch,
  DELETE as termDelete,
} from '../../src/pages/api/admin/board-terms';

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

describe('board roster routes — gate', () => {
  const url = 'http://localhost/api/admin/board-people';
  const termUrl = 'http://localhost/api/admin/board-terms';

  it('rejects an unauthenticated read with 401', async () => {
    expect((await GET(req(url, 'GET'))).status).toBe(401);
  });

  it('rejects an unauthenticated person write with 401', async () => {
    expect((await POST(req(url, 'POST', { fullName: 'X' }))).status).toBe(401);
    expect(
      (await PATCH(req(url, 'PATCH', { id: 'p1', fullName: 'X' }))).status,
    ).toBe(401);
    expect((await DELETE(req(url, 'DELETE', { id: 'p1' }))).status).toBe(401);
  });

  it('rejects an unauthenticated term write with 401', async () => {
    expect(
      (
        await termPost(
          req(termUrl, 'POST', { personId: 'p1', termStart: '2026-01-01' }),
        )
      ).status,
    ).toBe(401);
    expect((await termPatch(req(termUrl, 'PATCH', { id: 't1' }))).status).toBe(
      401,
    );
    expect(
      (await termDelete(req(termUrl, 'DELETE', { id: 't1' }))).status,
    ).toBe(401);
  });
});
