import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { confirmPropertyVerification } from '../../../server/verification/property';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // This route writes user_property_links and property_verifications — the
  // legacy tables the ADR 0022 backfill reads — so a confirmation landing
  // mid-run is exactly the drift the freeze exists to prevent. Checked here as
  // well as in middleware, per the two-layer convention of ADR 0013.
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const { code } = (await request.json()) as { code: string };
  const result = await confirmPropertyVerification(env, ctx.userId, code);
  return Response.json(result, { status: result.ok ? 200 : 400 });
};
