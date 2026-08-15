import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { getCutoverMode } from '../../../server/authz/cutover-mode';
import { readJson } from '../../../server/http';
import { confirmPropertyVerification } from '../../../server/verification/property';
import { confirmPersonVerification } from '../../../server/roster/verification';

export const prerender = false;

// ADR 0022 phase 3c (#219/D1): the confirm half of the same one-contract,
// two-backend split as request.ts. Confirm is not a roster oracle either —
// both backends collapse every internal failure (expired, locked, wrong
// code, and any batch race under `derived`) into the same
// `{ ok: false, reason: 'mismatch' }` shape; only `expired`/`locked` carry
// their own distinguishable reason, unchanged from the legacy behavior this
// mirrors.
export const POST: APIRoute = async ({ request, locals }) => {
  // This route writes user_property_links and property_verifications
  // (legacy) or person_verifications/person_links (derived) — the tables the
  // ADR 0022 backfill reads — so a confirmation landing mid-run is exactly
  // the drift the freeze exists to prevent. Checked here as well as in
  // middleware, per the two-layer convention of ADR 0013.
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const body = parsed.value as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';

  const mode = await getCutoverMode(env);
  const result =
    mode === 'derived'
      ? await confirmPersonVerification(env, ctx.userId, code)
      : await confirmPropertyVerification(env, ctx.userId, code);
  return Response.json(result, { status: result.ok ? 200 : 400 });
};
