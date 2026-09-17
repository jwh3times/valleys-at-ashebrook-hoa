import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { PUT } from '../../src/pages/api/admin/dues';
import {
  PUT as putSiteSettings,
  POST as postSiteSettings,
} from '../../src/pages/api/admin/site';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { normalizeSiteSettings } from '../../src/lib/types';
import { eq } from 'drizzle-orm';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin dues — board', () => {
  it('upserts the dues settings singleton', async () => {
    const res = await PUT({
      request: new Request('http://localhost/api/admin/dues', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '250', notes: 'annual' }),
      }),
    } as never);
    expect(res.status).toBe(204);
    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'dues'));
    expect(JSON.parse(row.value)).toMatchObject({
      amount: '250',
      notes: 'annual',
    });
  });

  it('persists presentation fields but ignores gate values in the body (#363)', async () => {
    const body = {
      siteName: 'The Valleys at Ashebrook Residents',
      tagline: 'Welcome to our community',
      contactEmail: 'board@example.test',
      welcomeHeading: 'Welcome to the Valleys at Ashebrook',
      welcomeBody: 'Welcome neighbors.',
      officialMode: true,
      liveVotingEnabled: true,
      disclaimerText: '',
      aboutBody: '',
    };
    const res = await putSiteSettings({
      request: new Request('http://localhost/api/admin/site', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    } as never);
    expect(res.status).toBe(204);
    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'site'));
    const stored = normalizeSiteSettings(JSON.parse(row.value));

    // The presentation fields the body carried landed...
    expect(stored.welcomeBody).toBe('Welcome neighbors.');
    // ...but the gate values did not, even on this very first save: PUT
    // never sets a gate, only the audited transition does.
    expect(stored.officialMode).toBe(false);
    expect(stored.liveVotingEnabled).toBe(false);
  });

  it('turns live voting on only through the audited transition, never the blob PUT', async () => {
    const res = await postSiteSettings({
      request: new Request('http://localhost/api/admin/site', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'setGate',
          key: 'liveVotingEnabled',
          expected: false,
          value: true,
        }),
      }),
    } as never);
    expect(res.status).toBe(204);
    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'site'));
    const stored = normalizeSiteSettings(JSON.parse(row.value));
    expect(stored.liveVotingEnabled).toBe(true);
    // The presentation fields the earlier PUT wrote survive untouched.
    expect(stored.welcomeBody).toBe('Welcome neighbors.');
  });
});
