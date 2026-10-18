import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireApiCapability,
  resolveAuthContext,
} from '../../../../server/authz/api-guards';
import { getDb } from '../../../../server/db/client';
import { driveConnection } from '../../../../server/db/schema';
import { driveConfig, notConfigured } from '../../../../server/drive/config';
import { revokeToken } from '../../../../server/drive/google';
import { recordDriveConnectionChange } from '../../../../server/drive/history';
import { unsealRefreshToken } from '../../../../server/drive/seal';

export const prerender = false;

/**
 * Disconnect the association's Google Drive (#290 slice 2, spec decision 1).
 * System Administrators only, and exempt from the write freeze: stopping
 * access must never wait for a freeze to lift (write-freeze.ts ALWAYS_LIVE).
 *
 * Revokes the stored credential at Google, then deletes the row whether or not
 * the revoke succeeded — once the credential is gone the site cannot use the
 * access, which is the part the site controls. Deletes whatever row is there,
 * with no revision check: the intent is to stop access, not to undo one
 * particular state. Imported documents are untouched, and Google keeps its
 * per-file grants, so reconnecting the same account restores them.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireApiCapability(
    locals,
    request,
    env,
    'systemAdmin',
  );
  if (denied) return denied;
  const config = driveConfig(env);
  if (!config) return notConfigured();
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const [row] = await getDb(env)
    .select({
      status: driveConnection.status,
      googleSub: driveConnection.googleSub,
      keyVersion: driveConnection.keyVersion,
      refreshTokenSealed: driveConnection.refreshTokenSealed,
    })
    .from(driveConnection)
    .where(eq(driveConnection.id, 1));
  if (!row) return new Response(null, { status: 204 });

  let revokeFailed = false;
  if (row.refreshTokenSealed) {
    try {
      const token = await unsealRefreshToken(
        config.tokenKey,
        row.refreshTokenSealed,
        { googleSub: row.googleSub, keyVersion: row.keyVersion },
      );
      revokeFailed = !(await revokeToken(token));
    } catch {
      // Sealed under a key this Worker no longer has: the site cannot use it
      // either, so the delete below still ends the site's access.
      revokeFailed = true;
    }
  }

  await env.DATABASE.batch([
    env.DATABASE.prepare('DELETE FROM drive_connection WHERE id = 1'),
    recordDriveConnectionChange(
      env,
      row.status,
      'none',
      ctx.userId,
      Date.now(),
    ),
  ]);
  return Response.json({ revokeFailed });
};
