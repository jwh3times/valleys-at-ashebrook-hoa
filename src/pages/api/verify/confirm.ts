import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { confirmPropertyVerification } from '../../../server/verification/property';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const { code } = (await request.json()) as { code: string };
  const result = await confirmPropertyVerification(env, ctx.userId, code);
  return Response.json(result, { status: result.ok ? 200 : 400 });
};
