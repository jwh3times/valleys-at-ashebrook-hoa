import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import {
  DEFAULT_SITE_SETTINGS,
  normalizeSiteSettings,
  type SiteSettings,
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
