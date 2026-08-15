import { getAuthContext } from './context';
import { requireCapability, Forbidden } from './guards';
import type { AuthContext, Capability } from './guards';
import { writeFreezeError } from './write-freeze';
import { associationDateIso } from '../../lib/format';

/**
 * Resolve the caller exactly once. Prefer the context the middleware already put
 * on `locals` (a full session + role/link read is done there per request); fall
 * back to a fresh lookup only when `locals` is absent — e.g. Worker-pool tests
 * that invoke handlers directly without running middleware. Fail-closed: a
 * missing `locals` can never yield a privileged context, since the fallback
 * returns `null` for an anonymous caller.
 */
export async function resolveAuthContext(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  return (
    locals?.authContext ??
    (await getAuthContext(request, env, associationDateIso()))
  );
}

/**
 * Returns a Response to short-circuit (503/401/403), or null if the caller is
 * board and the request may proceed.
 *
 * The write freeze is checked FIRST, and only for mutating verbs: it is the
 * most restrictive answer, it does not depend on who is asking, and putting it
 * ahead of session resolution means no path that returns early from the auth
 * lookup can let a write through during a freeze. Admin reads are unaffected —
 * the board must still be able to see the record while the site is frozen, and
 * the flip's smoke test depends on it.
 *
 * Every admin route already calls this, so the freeze reaches all twenty of
 * them without touching a single call site.
 */
export async function requireBoard(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<Response | null> {
  return requireApiCapability(locals, request, env, 'board');
}

/**
 * The same gate for a route whose declared capability is finer than `board` —
 * the System-Administrator-only technical surfaces (#205): Roster Redaction,
 * redaction cleanup, access-denial detail, and the audit integrity views.
 *
 * Identical order to `requireBoard`: freeze (mutating verbs only), then
 * session, then the capability. Under `cutover_mode = legacy` nobody holds
 * these capabilities — System Administration is a new-model concept with no
 * legacy equivalent — so these routes answer 403 for every caller until the
 * flip, which is correct: the surfaces they gate act on new-model rows that
 * production does not yet serve.
 */
export async function requireApiCapability(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
  capability: Capability,
): Promise<Response | null> {
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  try {
    requireCapability(ctx, capability);
  } catch (e) {
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  return null;
}
