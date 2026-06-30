import { getAuthContext } from './context';
import { requireRole, Forbidden } from './guards';

/** Returns a Response to short-circuit (401/403), or null if the caller is board. */
export async function requireBoard(request: Request, env: Env): Promise<Response | null> {
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  try {
    requireRole(ctx, 'board');
  } catch (e) {
    if (e instanceof Forbidden) return new Response('Forbidden', { status: 403 });
    throw e;
  }
  return null;
}
