import { getAuthContext } from './context';
import { requireRole, Forbidden } from './guards';
import type { AuthContext } from './guards';

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
  return locals?.authContext ?? (await getAuthContext(request, env));
}

/** Returns a Response to short-circuit (401/403), or null if the caller is board. */
export async function requireBoard(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<Response | null> {
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  try {
    requireRole(ctx, 'board');
  } catch (e) {
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  return null;
}
