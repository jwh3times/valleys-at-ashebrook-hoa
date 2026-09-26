import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRoster, seedRoster } from './dual-fixtures';

const getSession = vi.hoisted(() => vi.fn());
vi.mock('../../src/server/auth', () => ({
  createAuth: () => ({ api: { getSession } }),
}));
import { GET } from '../../src/pages/api/me';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
beforeEach(async () => {
  await resetRoster();
  await env.DATABASE.prepare('DELETE FROM users').run();
  await env.DATABASE.prepare('DELETE FROM cutover_settings').run();
});

describe('permanent roster authorization', () => {
  it('uses current links and grants on every request without consulting stored roles', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-a',
          owners: [{ id: 'person-a', name: 'Synthetic Resident' }],
        },
      ],
      accounts: [
        {
          id: 'linked',
          role: 'visitor',
          linkedTo: 'person-a',
          grants: ['system_admin'],
        },
      ],
    });
    getSession.mockResolvedValue({ user: { id: 'linked', role: 'visitor' } });
    const read = async () =>
      (
        await GET({ request: new Request('http://localhost/api/me') } as never)
      ).json();
    const initial = await read();
    expect(initial).toMatchObject({
      contentTier: 'board',
      capabilities: expect.arrayContaining(['member', 'board', 'systemAdmin']),
    });
    await env.DATABASE.prepare(
      "UPDATE access_grants SET ended_at = 2, end_reason = 'revoked'",
    ).run();
    expect(await read()).toEqual({
      contentTier: 'homeowner',
      capabilities: ['member'],
    });
    await env.DATABASE.prepare(
      "UPDATE person_links SET ended_at = 2, end_reason = 'self_unlink'",
    ).run();
    expect(await read()).toEqual({ contentTier: 'visitor', capabilities: [] });
  });

  it('refuses stored board access without a current Person Link, even with no cutover setting', async () => {
    await seedRoster({ accounts: [{ id: 'unlinked', role: 'board' }] });
    getSession.mockResolvedValue({ user: { id: 'unlinked', role: 'board' } });
    const response = await GET({
      request: new Request('http://localhost/api/me'),
    } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      capabilities: [],
      contentTier: 'visitor',
    });
  });
});
