import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { associationDateIso } from '../../../lib/format';
import { verifyTurnstile } from '../../../server/authz/turnstile';
import { readJson } from '../../../server/http';
import {
  checkUserRateLimit,
  setCooldown,
} from '../../../server/verification/rate-limit';
import { requestPersonVerification } from '../../../server/roster/verification';

export const prerender = false;

// D2: after the cheap gates below (freeze, session, malformed body, bad
// channel, Turnstile — none of which touch the roster), EVERY remaining path
// converges on this ONE response: success, unknown address, unmatched name,
// ambiguous name, an organization-owned lot, a shared/ambiguous contact,
// both already-linked collisions, and every rate limit. A distinguishable
// byte, status, or timing-order difference across those paths is a security
// defect. There is no more 429 on this route.
//
// TIMING is enforced structurally, not by hoping the paths cost the same.
// The matched path used to perform a Resend or Twilio HTTP call plus several
// KV writes before responding, while an unmatched address returned after a
// few D1 reads and a rate-limited caller returned fastest of all — latency
// alone distinguished "this address and name matched a Person with a unique
// contact" from every other outcome, which is precisely the oracle the
// uniform body exists to close. So the rate-limit check, the roster work, and
// the send all happen AFTER the response is produced, handed to the runtime's
// `waitUntil`. Every path now answers at the same point in the handler.
export const UNIFORM_REQUEST_RESPONSE = {
  ok: true,
  message: 'If the information matches our records, a code has been sent.',
} as const;

export const POST: APIRoute = async ({ request, locals }) => {
  // Freeze before authentication or roster work.
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const body = parsed.value as {
    address?: unknown;
    name?: unknown;
    channel?: unknown;
    turnstileToken?: unknown;
  };
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const channel = body.channel;
  if (channel !== 'email' && channel !== 'sms')
    return Response.json(
      { ok: false, message: 'Choose email or text message delivery.' },
      { status: 400 },
    );
  if (!(await verifyTurnstile(env, body.turnstileToken as string, request)))
    return Response.json(
      {
        ok: false,
        message: 'Could not validate the captcha. Complete it again and retry.',
      },
      { status: 400 },
    );

  // Every gate above answers a real, distinguishable status. Everything from
  // here on is a roster question, and every roster question gets the same
  // answer regardless of what actually happened internally — including how
  // long it took, which is why none of it is awaited before the response.
  const accountId = ctx.userId;
  const rosterWork = async () => {
    const rl = await checkUserRateLimit(env, accountId);
    if (!rl.ok) return;
    await setCooldown(env, accountId);

    await requestPersonVerification(
      env,
      associationDateIso(),
      accountId,
      address,
      name,
      channel,
    );
  };

  // `locals.cfContext` is the ExecutionContext under @astrojs/cloudflare v14
  // (v6 of Astro removed `locals.runtime.ctx` — its getter now throws, so do
  // not reach for it). In the Worker it is always present, and deferring is
  // the whole point of this route. Handlers invoked directly (the Workers test
  // pool) have no `cfContext`, so the work is awaited instead: every existing
  // test still observes the effects, and the one test that proves the response
  // does not wait for the sender supplies its own `waitUntil`.
  const cfContext = locals?.cfContext;
  if (cfContext) {
    cfContext.waitUntil(
      rosterWork().catch((err: unknown) => {
        console.error('[verify/request] deferred roster work failed:', err);
      }),
    );
  } else {
    await rosterWork();
  }

  return Response.json(UNIFORM_REQUEST_RESPONSE);
};
