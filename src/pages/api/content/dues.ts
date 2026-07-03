import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../server/db/client';
import { settings } from '../../../server/db/schema';
import {
  DEFAULT_DUES_SETTINGS,
  normalizeDuesSettings,
} from '../../../lib/types';

export const prerender = false;

export const GET: APIRoute = async () => {
  const [row] = await getDb(env)
    .select()
    .from(settings)
    .where(eq(settings.key, 'dues'));
  if (!row) return Response.json(DEFAULT_DUES_SETTINGS);
  try {
    return Response.json(normalizeDuesSettings(JSON.parse(row.value)));
  } catch {
    return Response.json(DEFAULT_DUES_SETTINGS);
  }
};
