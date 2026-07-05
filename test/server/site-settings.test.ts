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

  it('round-trips the board-editable disclaimer and About copy', async () => {
    const value = JSON.stringify({
      disclaimerText: 'Our disclaimer.',
      aboutBody: 'About para one.\n\nAbout para two.',
    });
    await getDb(env)
      .insert(settings)
      .values({ key: 'site', value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
    const s = await getSiteSettings(env);
    expect(s.disclaimerText).toBe('Our disclaimer.');
    expect(s.aboutBody).toBe('About para one.\n\nAbout para two.');
  });

  // Placed last: this seeds a malformed value that overwrites the row, so it
  // must not run before the earlier cases that depend on well-formed data.
  it('fails closed to defaults when the stored value is malformed JSON', async () => {
    const value = '{not json';
    await getDb(env)
      .insert(settings)
      .values({ key: 'site', value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
    const s = await getSiteSettings(env);
    expect(s.officialMode).toBe(false);
    expect(s.siteName).toBe(DEFAULT_SITE_SETTINGS.siteName);
  });
});
