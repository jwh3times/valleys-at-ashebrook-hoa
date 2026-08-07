import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireVotingApi } from '../../server/authz/voting-guards';

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireVotingApi(locals, request, env);
  if (!gate.ok) return gate.res;
  return new Response('Unknown action', { status: 400 });
};
