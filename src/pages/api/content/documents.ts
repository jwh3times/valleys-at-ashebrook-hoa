import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { fetchDocumentsFor } from '../../../server/content/reads';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const role = (await getAuthContext(request, env))?.role ?? 'visitor';
  return Response.json(await fetchDocumentsFor(env, role));
};
