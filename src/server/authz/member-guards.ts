import { getSiteSettings } from '../content/settings';
import { resolveAuthContext } from './api-guards';
import { requireCapability, Forbidden } from './guards';
import type { AuthContext } from './guards';
import { writeFreezeError } from './write-freeze';
import { jsonContentError, sameOriginError } from './voting-guards';
import { paymentsReadable, paymentsStartable } from '../payments/gate';

/**
 * Gate for the homeowner-write API surface (/api/member/*, /api/vote), in
 * the order ADR 0019 fixes: officialMode FIRST — off means 404, never 403,
 * so the surface's existence is not advertised (getSiteSettings fails
 * closed to off) — then the write freeze, then 401 for anonymous, then 403
 * without the `member` capability. Per-lot scoping is still the caller's job,
 * via ctx.lotIds / requirePropertyAccess.
 *
 * Board Access does not imply membership: a caller needs current Lot Authority
 * for the member capability, independently of their access to board content.
 *
 * The freeze sits AFTER the mode check so a frozen site does not advertise a
 * surface that officialMode-off is meant to hide, and BEFORE authentication
 * for the reasons given on requireBoard. It covers every verb here, not only
 * mutating ones: this surface has no read-only half worth keeping live, and
 * its reads exist to feed its writes.
 *
 * Reads settings directly rather than trusting locals.site: a guard must not
 * be spoofable by whatever a caller managed to put on locals.
 */
export async function requireMemberApi(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; res: Response }> {
  const site = await getSiteSettings(env);
  if (!site.officialMode)
    return { ok: false, res: new Response('Not found', { status: 404 }) };
  const frozen = await writeFreezeError(env, request);
  if (frozen) return { ok: false, res: frozen };
  return requireMemberCaller(locals, request, env);
}

/** The session (401) and the `member` capability (403), the last two steps of
 * every homeowner-write guard. */
async function requireMemberCaller(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; res: Response }> {
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx)
    return { ok: false, res: new Response('Unauthorized', { status: 401 }) };
  try {
    requireCapability(ctx, 'member');
  } catch (e) {
    if (e instanceof Forbidden)
      return { ok: false, res: new Response('Forbidden', { status: 403 }) };
    throw e;
  }
  return { ok: true, ctx };
}

/**
 * Gate for STARTING an online payment, `POST /api/member/payments` (ADR 0025,
 * #542), in the order ADR 0025 fixes, which is the live-voting order:
 *
 * 1. `officialMode`, `lotRecordsEnabled` and `onlinePaymentsEnabled`, and a
 *    configured provider (`paymentsStartable`) → 404, so the surface is not
 *    advertised;
 * 2. the write freeze → 503;
 * 3. exact `Origin` → 403, and the JSON media type → 415: a request that moves
 *    money is never a cross-site form post;
 * 4. session → 401; the `member` capability → 403.
 *
 * Lot Authority over the Lot named in the body is checked by the route,
 * inside its insert, and answers the masked 404. Reads settings directly
 * rather than trusting `locals.site`, as `requireMemberApi` does.
 */
export async function requirePaymentStartApi(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; res: Response }> {
  if (!paymentsStartable(await getSiteSettings(env), env))
    return { ok: false, res: new Response('Not found', { status: 404 }) };
  return requirePaymentCaller(locals, request, env);
}

/**
 * Gate for CHASING an online payment, `POST /api/member/payments/refresh`
 * (#544): the order above, except that step 1 asks only for `officialMode`,
 * `lotRecordsEnabled` and a configured provider (`paymentsReadable`). Turning
 * online payments off stops new checkouts, never a homeowner checking one
 * already made. The payment is scoped by the route through Lot Authority on
 * the day it started, and answers the masked 404.
 */
export async function requirePaymentRefreshApi(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; res: Response }> {
  if (!paymentsReadable(await getSiteSettings(env), env))
    return { ok: false, res: new Response('Not found', { status: 404 }) };
  return requirePaymentCaller(locals, request, env);
}

/** Steps 2 to 4 of both payment gates: freeze, headers, session, `member`. */
async function requirePaymentCaller(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; res: Response }> {
  const frozen = await writeFreezeError(env, request);
  if (frozen) return { ok: false, res: frozen };
  const headerError = sameOriginError(request) ?? jsonContentError(request);
  if (headerError) return { ok: false, res: headerError };
  return requireMemberCaller(locals, request, env);
}
