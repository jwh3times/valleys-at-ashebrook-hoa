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
  exchangeCode,
  grantsDriveFile,
  revokeToken,
} from '../../../../server/drive/google';
import { OAUTH_COOKIE, callbackUrl } from '../../../../server/drive/oauth';
import {
  sealRefreshToken,
  verifyOAuthState,
} from '../../../../server/drive/seal';
import { recordDriveConnectionChange } from '../../../../server/drive/history';

export const prerender = false;

type Outcome =
  | 'connected'
  | 'expired'
  | 'cancelled'
  | 'google-error'
  | 'drive-not-granted'
  | 'no-refresh-token'
  | 'wrong-account'
  | 'conflict';

/** Back to the admin panel, which reads `drive` to explain what happened. */
function finish(outcome: Outcome): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `/admin?drive=${outcome}`,
      'set-cookie': `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      'cache-control': 'no-store',
    },
  });
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/**
 * Google's redirect back after consent (#290 slice 2, spec decision 1).
 * System Administrators only, frozen (a GET that writes), and every check is
 * repeated inside the write: a connect inserts the single row and fails if one
 * appeared meanwhile; a reconnect updates only the revision it started from.
 *
 * A refused grant is revoked only when it is NOT the stored connection's own
 * account: Google's revocation removes everything that account granted the
 * project, so revoking a same-account token would also kill the connection.
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

  const cookie = cookieValue(request, OAUTH_COOKIE);
  const started = cookie
    ? await verifyOAuthState(config.tokenKey, cookie)
    : null;
  if (
    !started ||
    started.state !== url.searchParams.get('state') ||
    started.accountId !== ctx.userId
  )
    return finish('expired');
  if (url.searchParams.get('error')) return finish('cancelled');
  const code = url.searchParams.get('code');
  if (!code) return finish('expired');

  let granted;
  try {
    granted = await exchangeCode(config, {
      code,
      codeVerifier: started.codeVerifier,
      redirectUri: callbackUrl(request),
    });
  } catch (err) {
    console.error('[drive] code exchange failed', err);
    return finish('google-error');
  }

  const db = getDb(env);
  const readStored = async () =>
    (
      await db
        .select({
          status: driveConnection.status,
          googleSub: driveConnection.googleSub,
          revision: driveConnection.revision,
        })
        .from(driveConnection)
        .where(eq(driveConnection.id, 1))
    )[0];
  const refuse = async (outcome: Outcome) => {
    const stored = await readStored();
    if (!stored || stored.googleSub !== granted.googleSub)
      await revokeToken(granted.refreshToken ?? granted.accessToken);
    return finish(outcome);
  };

  if (!grantsDriveFile(granted.scope)) return refuse('drive-not-granted');
  if (!granted.refreshToken) return refuse('no-refresh-token');

  const stored = await readStored();
  if (started.intent === 'connect' && stored) return refuse('conflict');
  if (started.intent === 'reconnect') {
    if (!stored) return refuse('conflict');
    if (stored.googleSub !== granted.googleSub) return refuse('wrong-account');
  }

  const sealed = await sealRefreshToken(config.tokenKey, granted.refreshToken, {
    googleSub: granted.googleSub,
    keyVersion: 1,
  });
  const now = Date.now();
  const scope = granted.scope.join(' ');
  const record = (oldValue: string) =>
    recordDriveConnectionChange(env, oldValue, 'connected', ctx.userId, now);

  let written = false;
  if (!stored) {
    try {
      await env.DATABASE.batch([
        env.DATABASE.prepare(
          `INSERT INTO drive_connection (id, status, google_sub, google_email, refresh_token_sealed, key_version, granted_scope, connected_by, connected_at)
           VALUES (1, 'connected', ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(
          granted.googleSub,
          granted.googleEmail,
          sealed,
          scope,
          ctx.userId,
          now,
        ),
        record('none'),
      ]);
      written = true;
    } catch (err) {
      // A row appeared since the read: another connect won the race.
      if (!/UNIQUE|PRIMARY KEY|constraint/i.test(String(err))) throw err;
    }
  } else {
    const [update] = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE drive_connection
            SET status = 'connected', refresh_token_sealed = ?, key_version = 1,
                google_email = ?, granted_scope = ?, connected_by = ?,
                connected_at = ?, broken_at = NULL, broken_reason = NULL,
                revision = revision + 1
          WHERE id = 1 AND revision = ? AND google_sub = ?`,
      ).bind(
        sealed,
        granted.googleEmail,
        scope,
        ctx.userId,
        now,
        started.revision,
        granted.googleSub,
      ),
      record(stored.status),
    ]);
    written = (update.meta.changes ?? 0) === 1;
  }
  if (!written) return refuse('conflict');
  return finish('connected');
};
