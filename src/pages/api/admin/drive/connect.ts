import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireApiCapability,
  resolveAuthContext,
} from '../../../../server/authz/api-guards';
import { isWriteFrozen } from '../../../../server/authz/write-freeze';
import { getDb } from '../../../../server/db/client';
import { driveConnection } from '../../../../server/db/schema';
import { driveConfig, notConfigured } from '../../../../server/drive/config';
import {
  DRIVE_SCOPES,
  GOOGLE_AUTH_URL,
  OAUTH_COOKIE,
  OAUTH_COOKIE_MAX_AGE_SECONDS,
  callbackUrl,
} from '../../../../server/drive/oauth';
import {
  pkceChallenge,
  randomToken,
  signOAuthState,
} from '../../../../server/drive/seal';

export const prerender = false;

/**
 * Start connecting (or reconnecting) the association's Google Drive account
 * (#290 slice 2, spec decision 1). System Administrators only. A GET because
 * it is a browser navigation to Google, but it begins a write, so it checks
 * the write freeze itself: the freeze policy leaves admin GETs live.
 */
export const GET: APIRoute = async ({ request, locals, url }) => {
  const denied = await requireApiCapability(
    locals,
    request,
    env,
    'systemAdmin',
  );
  if (denied) return denied;
  if (await isWriteFrozen(env))
    return new Response('Site is temporarily read-only for maintenance', {
      status: 503,
    });
  const config = driveConfig(env);
  if (!config) return notConfigured();
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const reconnect = url.searchParams.get('reconnect') === '1';
  const [row] = await getDb(env)
    .select({
      status: driveConnection.status,
      revision: driveConnection.revision,
    })
    .from(driveConnection)
    .where(eq(driveConnection.id, 1));
  if (row?.status === 'connected' && !reconnect)
    return new Response(
      'Google Drive is already connected. Use Reconnect to replace its credential.',
      { status: 409 },
    );

  const state = randomToken();
  const codeVerifier = randomToken();
  const cookie = await signOAuthState(config.tokenKey, {
    state,
    codeVerifier,
    accountId: ctx.userId,
    intent: row ? 'reconnect' : 'connect',
    revision: row?.revision ?? null,
    exp: Date.now() + OAUTH_COOKIE_MAX_AGE_SECONDS * 1000,
  });

  const to = new URL(GOOGLE_AUTH_URL);
  to.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl(request),
    response_type: 'code',
    scope: DRIVE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    code_challenge: await pkceChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      location: to.toString(),
      'set-cookie': `${OAUTH_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}`,
      'cache-control': 'no-store',
    },
  });
};
