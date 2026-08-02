import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  GET,
  POST,
  PATCH,
  DELETE,
} from '../../src/pages/api/admin/resolutions';

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

describe('resolutions admin route — gate', () => {
  const url = 'http://localhost/api/admin/resolutions';

  it('rejects an unauthenticated read with 401', async () => {
    expect((await GET(req(url, 'GET'))).status).toBe(401);
  });

  it('rejects an unauthenticated create with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            number: 'R-2026-01',
            title: 'Pool hours',
            bodyMd: 'The pool is open 9am to 9pm.',
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated adopt with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'adopt',
            id: 'r1',
            effectiveDate: '2026-01-01',
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated supersede with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'supersede',
            id: 'r2',
            supersedesId: 'r1',
            effectiveDate: '2026-01-01',
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated repeal with 401', async () => {
    expect(
      (await POST(req(url, 'POST', { action: 'repeal', id: 'r1' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated patch with 401', async () => {
    expect(
      (await PATCH(req(url, 'PATCH', { id: 'r1', title: 'X' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated delete with 401', async () => {
    expect((await DELETE(req(url, 'DELETE', { id: 'r1' }))).status).toBe(401);
  });
});
