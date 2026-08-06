import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { PUT } from '../../src/pages/api/admin/dues';
import { PUT as putSiteSettings } from '../../src/pages/api/admin/site';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { normalizeSiteSettings } from '../../src/lib/types';
import { eq } from 'drizzle-orm';

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

  it('persists the live voting setting', async () => {
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

    expect(normalizeSiteSettings(JSON.parse(row.value)).liveVotingEnabled).toBe(
      true,
    );
  });
});
