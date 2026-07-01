import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../server/db/client';
import { settings } from '../../../server/db/schema';
import { DEFAULT_SITE_SETTINGS } from '../../../lib/types';

export const prerender = false;

export const GET: APIRoute = async () => {
  const [row] = await getDb(env)
    .select()
    .from(settings)
    .where(eq(settings.key, 'site'));
  if (!row) return Response.json(DEFAULT_SITE_SETTINGS);
  try {
    return Response.json(JSON.parse(row.value));
  } catch {
    return Response.json(DEFAULT_SITE_SETTINGS);
  }
};
