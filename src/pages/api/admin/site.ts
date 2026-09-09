import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { settings } from '../../../server/db/schema';
import { normalizeSiteSettings } from '../../../lib/types';
import { readJson } from '../../../server/http';

export const prerender = false;

export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const value = JSON.stringify(normalizeSiteSettings(parsed.value));
  const now = new Date();
  await getDb(env)
    .insert(settings)
    .values({ key: 'site', value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    });
  return new Response(null, { status: 204 });
};
