import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getSiteSettings } from '../../src/server/content/settings';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('getSiteSettings', () => {
  it('returns defaults (official mode off) when no row exists', async () => {
    const s = await getSiteSettings(env);
    expect(s.officialMode).toBe(false);
    expect(s.siteName).toBe(DEFAULT_SITE_SETTINGS.siteName);
  });

  it('normalizes a stored legacy hoaName into siteName', async () => {
    const value = JSON.stringify({
      hoaName: 'Legacy HOA',
      welcomeHeading: 'Hi',
    });
    await getDb(env)
      .insert(settings)
      .values({ key: 'site', value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
    const s = await getSiteSettings(env);
    expect(s.siteName).toBe('Legacy HOA');
    expect(s.welcomeHeading).toBe('Hi');
    expect(s.officialMode).toBe(false);
  });
});
