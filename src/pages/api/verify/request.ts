import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { getCutoverMode } from '../../../server/authz/cutover-mode';
import { associationDateIso } from '../../../lib/format';
import { verifyTurnstile } from '../../../server/authz/turnstile';
import { readJson } from '../../../server/http';
import {
  checkUserRateLimit,
  setCooldown,
} from '../../../server/verification/rate-limit';
import { requestPropertyVerification } from '../../../server/verification/property';
import { requestPersonVerification } from '../../../server/roster/verification';

export const prerender = false;

// ADR 0022 phase 3c (#219/D1): ONE route contract, TWO backends branched on
// `getCutoverMode`. Production runs `legacy` until the flip and the roster
// tables are empty until the authoritative backfill, so a pure Person flow
// would silently break pre-flip onboarding — mirroring the whole program's
// philosophy ("legacy authoritative by flag, not code"). `name` is always
// accepted by the contract; the legacy backend collects it but does not
// match on it (that gap closes at the flip).
//
// D2: after the cheap gates below (freeze, session, malformed body, bad
// channel, Turnstile — none of which touch the roster), EVERY remaining path
// converges on this ONE response: success, unknown address, unmatched name,
// ambiguous name, an organization-owned lot, a shared/ambiguous contact,
// both already-linked collisions, and every rate limit. A distinguishable
// byte, status, or timing-order difference across those paths is a security
// defect. There is no more 429 on this route.
export const UNIFORM_REQUEST_RESPONSE = {
  ok: true,
  message: 'If the information matches our records, a code has been sent.',
} as const;

export const POST: APIRoute = async ({ request, locals }) => {
  // Frozen ahead of everything else — this route writes user_property_links
  // (legacy) or the new-model roster tables (derived) depending on mode,
  // either of which the ADR 0022 backfill reads.
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
  // answer regardless of what actually happened internally.
  const rl = await checkUserRateLimit(env, ctx.userId);
  if (rl.ok) {
    await setCooldown(env, ctx.userId);
    const mode = await getCutoverMode(env);
    if (mode === 'derived') {
      await requestPersonVerification(
        env,
        associationDateIso(),
        ctx.userId,
        address,
        name,
        channel,
      );
    } else {
      await requestPropertyVerification(
        env,
        ctx.userId,
        address,
        name,
        channel,
      );
    }
  }

  return Response.json(UNIFORM_REQUEST_RESPONSE);
};
