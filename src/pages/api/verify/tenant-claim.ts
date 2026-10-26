import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { associationDateIso } from '../../../lib/format';
import { readJson, stringField } from '../../../server/http';
import { tenantAccessAvailable } from '../../../server/roster/tenancy';
import {
  CLAIM_DAILY_LIMIT,
  CLAIM_REFUSAL_MESSAGES,
  claimTenantInvitation,
  spendClaimAttempt,
} from '../../../server/roster/tenancy-claim';

// A tenant claims a Tenancy invitation (ADR 0028, #294 slice 4; spec decision
// 4). `/tenant-invite` only displays the invitation, because mail scanners
// prefetch links; this POST is the only thing that consumes one.
//
// The checks run in the spec's order: the write freeze, a session, both gates
// (404), the per-Account daily limit, then the token. Every token failure is
// the same 400, so the route is no oracle for which invitations exist.

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Enforced here and in middleware so direct handler calls are covered.
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  if (!(await tenantAccessAvailable(env)))
    return new Response('Not found', { status: 404 });
  if (!(await spendClaimAttempt(env, ctx.userId)))
    return new Response(
      `At most ${CLAIM_DAILY_LIMIT} claim attempts a day; try again tomorrow`,
      { status: 429 },
    );

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const result = await claimTenantInvitation(
    env,
    ctx.userId,
    stringField(parsed.value, 'token'),
    associationDateIso(),
  );
  if (result.ok) return Response.json({ ok: true });
  if (result.reason === 'gates-off')
    return new Response('Not found', { status: 404 });
  return Response.json(
    {
      ok: false,
      reason: result.reason,
      message: CLAIM_REFUSAL_MESSAGES[result.reason],
    },
    { status: result.reason === 'invalid-invitation' ? 400 : 409 },
  );
};
