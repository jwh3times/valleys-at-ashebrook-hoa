import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { POST, PATCH, DELETE } from '../../src/pages/api/admin/motions';

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

describe('motions admin route — gate', () => {
  const url = 'http://localhost/api/admin/motions';

  it('rejects an unauthenticated create with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            meetingId: 'm1',
            text: 'Move to approve the budget',
            outcome: 'passed',
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated setVotes with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setVotes',
            motionId: 'mo1',
            entries: [],
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated setMemberVotes with 401', async () => {
    expect(
      (
        await POST(
          req(url, 'POST', {
            action: 'setMemberVotes',
            motionId: 'mo1',
            entries: [],
          }),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated patch with 401', async () => {
    expect(
      (await PATCH(req(url, 'PATCH', { id: 'mo1', text: 'X' }))).status,
    ).toBe(401);
  });

  it('rejects an unauthenticated delete with 401', async () => {
    expect((await DELETE(req(url, 'DELETE', { id: 'mo1' }))).status).toBe(401);
  });
});
