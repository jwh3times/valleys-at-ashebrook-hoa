import { getSiteSettings } from '../content/settings';
import { resolveAuthContext } from './api-guards';
import { requireRole, Forbidden } from './guards';
import type { AuthContext } from './guards';

export function sameOriginError(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin)
    return new Response('Forbidden', { status: 403 });
  return null;
}

export function jsonContentError(request: Request): Response | null {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim();
  return mediaType === 'application/json'
    ? null
    : new Response('Unsupported media type', { status: 415 });
}

export async function requireVotingApi(
  locals: App.Locals | undefined,
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; res: Response }> {
  const site = await getSiteSettings(env);
  if (!site.officialMode || !site.liveVotingEnabled)
    return { ok: false, res: new Response('Not found', { status: 404 }) };

  const originError = sameOriginError(request);
  if (originError) return { ok: false, res: originError };

  const contentError = jsonContentError(request);
  if (contentError) return { ok: false, res: contentError };

  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx)
    return { ok: false, res: new Response('Unauthorized', { status: 401 }) };
  try {
    requireRole(ctx, 'homeowner');
  } catch (error) {
    if (error instanceof Forbidden)
      return { ok: false, res: new Response('Forbidden', { status: 403 }) };
    throw error;
  }
  return { ok: true, ctx };
}
