import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import {
  DEFAULT_SITE_SETTINGS,
  DEFAULT_DUES_SETTINGS,
  normalizeSiteSettings,
  normalizeDuesSettings,
  type SiteSettings,
  type DuesSettings,
} from '../../lib/types';

/** Read + normalize the singleton site settings blob. Fail-closed to defaults (official mode off). */
export async function getSiteSettings(env: Env): Promise<SiteSettings> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'site'));
    if (!row) return { ...DEFAULT_SITE_SETTINGS };
    return normalizeSiteSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_SITE_SETTINGS };
  }
}

/** Read + normalize the singleton dues settings blob. Fail-closed to defaults. */
export async function getDuesSettings(env: Env): Promise<DuesSettings> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'dues'));
    if (!row) return { ...DEFAULT_DUES_SETTINGS };
    return normalizeDuesSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_DUES_SETTINGS };
  }
}
