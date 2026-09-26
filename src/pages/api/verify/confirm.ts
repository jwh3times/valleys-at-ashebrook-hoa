import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { readJson } from '../../../server/http';
import { confirmPersonVerification } from '../../../server/roster/verification';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Enforced here and in middleware so direct handler calls are covered.
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const body = parsed.value as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';

  const result = await confirmPersonVerification(env, ctx.userId, code);
  return Response.json(result, { status: result.ok ? 200 : 400 });
};
