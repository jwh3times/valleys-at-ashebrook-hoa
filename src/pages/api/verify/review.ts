import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { verificationReviewRequests } from '../../../server/db/roster-schema';

export const prerender = false;

// ADR 0022 phase 3c (#219/D6, applicant half): the explicit "ask the board to
// review" action. Nothing about /api/verify/request auto-queues anymore
// (#201) except the person-already-linked collision it handles internally —
// this route is the ONE other writer of `verification_review_requests`, and
// it writes the SAME table in both cutover modes: the review queue is a
// single operational surface regardless of which backend answered the
// request that preceded it.
//
// No Turnstile: the one-open-request-per-account partial unique index below,
// plus the session gate, is the flooding control — an applicant can create at
// most one open request no matter how many times they submit.
//
// Always the uniform 200, success or idempotent replay, because this is not
// a place to leak whether a prior request already exists.
export const UNIFORM_REVIEW_RESPONSE = {
  ok: true,
  message: 'Your request was sent to the board.',
} as const;

const MAX_ADDRESS_LENGTH = 200;
const MAX_NAME_LENGTH = 200;

export const POST: APIRoute = async ({ request, locals }) => {
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });

  const address = stringField(parsed.value, 'address').slice(
    0,
    MAX_ADDRESS_LENGTH,
  );
  const name = stringField(parsed.value, 'name').slice(0, MAX_NAME_LENGTH);
  if (!address || !name)
    return new Response('address and name are required', { status: 400 });
  const channelRaw = stringField(parsed.value, 'channel');
  const channel =
    channelRaw === 'email' || channelRaw === 'sms' ? channelRaw : null;

  // Idempotent under `verification_review_requests_open_unq`: a second
  // submission while one is already open is a silent no-op, never a second
  // row and never a distinguishable response.
  await getDb(env)
    .insert(verificationReviewRequests)
    .values({
      id: crypto.randomUUID(),
      accountId: ctx.userId,
      claimedAddress: address,
      claimedName: name,
      channel,
      internalReason: 'applicant_requested',
      status: 'open',
      createdAt: new Date(),
    })
    .onConflictDoNothing();

  return Response.json(UNIFORM_REVIEW_RESPONSE);
};
