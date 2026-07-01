import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { fetchAnnouncementsFor } from '../../../server/content/reads';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const role = (await getAuthContext(request, env))?.role ?? 'visitor';
  const rawLimit = new URL(request.url).searchParams.get('limit');
  const limit = rawLimit ? Number(rawLimit) || undefined : undefined;
  return Response.json(await fetchAnnouncementsFor(env, role, limit));
};
