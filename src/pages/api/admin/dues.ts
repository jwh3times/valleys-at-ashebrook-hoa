import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { settings } from '../../../server/db/schema';
import { normalizeDuesSettings } from '../../../lib/types';

export const prerender = false;

export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const value = JSON.stringify(normalizeDuesSettings(await request.json()));
  const now = new Date();
  await getDb(env)
    .insert(settings)
    .values({ key: 'dues', value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    });
  return new Response(null, { status: 204 });
};
