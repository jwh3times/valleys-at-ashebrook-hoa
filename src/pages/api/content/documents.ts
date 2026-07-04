import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { fetchDocumentsFor } from '../../../server/content/reads';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const role =
    (await resolveAuthContext(locals, request, env))?.role ?? 'visitor';
  return Response.json(await fetchDocumentsFor(env, role));
};
