import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { fetchAnnouncementsFor } from '../../../server/content/reads';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const role =
    (await resolveAuthContext(locals, request, env))?.role ?? 'visitor';
  // Clamp to a non-negative integer; a negative limit would otherwise drop items
  // off the end via slice(0, -n). Anything invalid means "no limit".
  const rawLimit = new URL(request.url).searchParams.get('limit');
  const n = rawLimit === null ? NaN : Number(rawLimit);
  const limit = Number.isInteger(n) && n >= 0 ? n : undefined;
  return Response.json(await fetchAnnouncementsFor(env, role, limit));
};
