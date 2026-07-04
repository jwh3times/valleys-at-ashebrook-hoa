import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { fetchAnnouncementsFor } from '../../../server/content/reads';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const role =
    (await resolveAuthContext(locals, request, env))?.role ?? 'visitor';
  const rawLimit = new URL(request.url).searchParams.get('limit');
  const limit = rawLimit ? Number(rawLimit) || undefined : undefined;
  return Response.json(await fetchAnnouncementsFor(env, role, limit));
};
