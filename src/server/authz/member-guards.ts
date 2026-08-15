import { getSiteSettings } from '../content/settings';
import { resolveAuthContext } from './api-guards';
import { requireCapability, Forbidden } from './guards';
import type { AuthContext } from './guards';
import { writeFreezeError } from './write-freeze';

/**
 * Gate for the homeowner-write API surface (/api/member/*, /api/vote), in
 * the order ADR 0019 fixes: officialMode FIRST — off means 404, never 403,
 * so the surface's existence is not advertised (getSiteSettings fails
 * closed to off) — then the write freeze, then 401 for anonymous, then 403
 * without the `member` capability. Per-lot scoping is still the caller's job,
 * via ctx.lotIds / requirePropertyAccess.
 *
 * `member` rather than a rank check is the one behavior change derived
 * authorization deliberately makes here. Under `cutover_mode = legacy` a board
 * caller still passes, because legacy synthesis reproduces the old ladder. Under
 * `derived`, a board member who owns no Lot does not — they have no association
 * basis for acting on a Lot, and the free pass was an artifact of ordering the
 * levels. That divergence is one of exactly two entries on #206's
 * explained-mismatch allow-list, and it appears at the flip, not before.
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
