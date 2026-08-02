import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET, POST, PATCH, DELETE } from '../../src/pages/api/admin/meetings';

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

describe('meetings admin route — gate', () => {
  const url = 'http://localhost/api/admin/meetings';

  it('rejects an unauthenticated read with 401', async () => {
    expect((await GET(req(url, 'GET'))).status).toBe(401);
  });

  it('rejects an unauthenticated detail read with 401', async () => {
    expect((await GET(req(`${url}?id=m1`, 'GET'))).status).toBe(401);
  });

  it('rejects an unauthenticated create with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            body: 'board',
            kind: 'regular',
            date: '2026-01-01',
            title: 'January meeting',
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated setAttendance with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setAttendance',
            meetingId: 'm1',
            entries: [],
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated setMemberAttendance with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setMemberAttendance',
            meetingId: 'm1',
            entries: [],
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated approve with 401', async () => {
    expect(
      (await POST(req(url, 'POST', { action: 'approve', meetingId: 'm1' })))
        .status,
    ).toBe(401);
  });

  it('rejects an unauthenticated unapprove with 401', async () => {
    expect(
      (await POST(req(url, 'POST', { action: 'unapprove', meetingId: 'm1' })))
        .status,
    ).toBe(401);
  });

  it('rejects an unauthenticated patch with 401', async () => {
    expect(
      (await PATCH(req(url, 'PATCH', { id: 'm1', title: 'X' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated delete with 401', async () => {
    expect((await DELETE(req(url, 'DELETE', { id: 'm1' }))).status).toBe(401);
  });
});
