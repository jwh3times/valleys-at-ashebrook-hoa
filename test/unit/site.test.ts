import { describe, it, expect } from 'vitest';
import {
  navLinks,
  brandTag,
  displayName,
  siteTitle,
  SITE_NAME,
  OFFICIAL_ORG_NAME,
} from '../../src/lib/site';
import {
  normalizeSiteSettings,
  DEFAULT_SITE_SETTINGS,
} from '../../src/lib/types';

describe('site branding helpers', () => {
  it('hides the Dues nav link when official mode is off, shows it when on', () => {
    expect(navLinks(false).some((l) => l.href === '/dues')).toBe(false);
    expect(navLinks(true).some((l) => l.href === '/dues')).toBe(true);
  });

  it('brandTag reflects the mode', () => {
    expect(brandTag(false)).toBe('Residents');
    expect(brandTag(true)).toBe('Homeowners Association');
  });

  it('displayName uses the resident name when off and the org name when on', () => {
    const base = { ...DEFAULT_SITE_SETTINGS };
    expect(displayName({ ...base, officialMode: false })).toBe(SITE_NAME);
    expect(displayName({ ...base, officialMode: true })).toBe(
      OFFICIAL_ORG_NAME,
    );
  });

  it('siteTitle drops the suffix for Home and adds it otherwise', () => {
    const s = { ...DEFAULT_SITE_SETTINGS, officialMode: false };
    expect(siteTitle('Home', s)).toBe(SITE_NAME);
    expect(siteTitle('Dues', s)).toBe(`Dues | ${SITE_NAME}`);
  });
});

describe('normalizeSiteSettings', () => {
  it('defaults officialMode to false and siteName to the resident name', () => {
    const s = normalizeSiteSettings({});
    expect(s.officialMode).toBe(false);
    expect(s.siteName).toBe(DEFAULT_SITE_SETTINGS.siteName);
  });

  it('maps a legacy hoaName onto siteName and drops hoaName', () => {
    const s = normalizeSiteSettings({ hoaName: 'Old Name' });
    expect(s.siteName).toBe('Old Name');
    expect('hoaName' in s).toBe(false);
  });

  it('prefers an explicit siteName over a legacy hoaName', () => {
    expect(
      normalizeSiteSettings({ siteName: 'New', hoaName: 'Old' }).siteName,
    ).toBe('New');
  });

  it('coerces officialMode to a strict boolean', () => {
    expect(normalizeSiteSettings({ officialMode: 'yes' }).officialMode).toBe(
      false,
    );
    expect(normalizeSiteSettings({ officialMode: true }).officialMode).toBe(
      true,
    );
  });
});
