import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { driveConnection } from '../db/schema';
import type { DriveConfig } from './config';
import { GoogleTokenError, refreshAccessToken } from './google';
import { recordDriveConnectionChange } from './history';
import { unsealRefreshToken } from './seal';

// The stored Drive connection in use (#290 slice 2): minting an access token
// from it, and recording it broken when Google says the grant is gone. Shared
// by the keepalive and, in slice 3, the Picker session and the import route.

export async function readConnection(env: Env) {
  const [row] = await getDb(env)
    .select()
    .from(driveConnection)
    .where(eq(driveConnection.id, 1));
  return row ?? null;
}

/**
 * The row a request read, identified for a later compare-and-swap. `revision`
 * alone is not enough: disconnect deletes the row, so the next connect starts
 * again at revision 1. The sealed credential is unique to one connection (each
 * seal draws a fresh random IV), so matching it as well means a request that
 * read an old connection can never write to a newer one.
 */
export interface ConnectionVersion {
  revision: number;
  sealed: string;
}

/**
 * Record the connection broken and clear its credential, as a compare-and-swap
 * on the version that was read: a request that read the row before a
 * reconnect or disconnect cannot overwrite the newer state. Returns whether
 * this call marked it.
 */
export async function markBroken(
  env: Env,
  input: ConnectionVersion & { reason: string; actor: string },
): Promise<boolean> {
  const now = Date.now();
  const [update] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE drive_connection
          SET status = 'broken', refresh_token_sealed = NULL, broken_at = ?,
              broken_reason = ?, revision = revision + 1
        WHERE id = 1 AND status = 'connected' AND revision = ?
          AND refresh_token_sealed = ?`,
    ).bind(now, input.reason, input.revision, input.sealed),
    recordDriveConnectionChange(env, 'connected', 'broken', input.actor, now),
  ]);
  return (update.meta.changes ?? 0) === 1;
}

export type MintResult =
  | {
      kind: 'minted';
      accessToken: string;
      expiresIn: number;
      version: ConnectionVersion;
    }
  | { kind: 'unavailable' }
  | { kind: 'broken' };

/**
 * Mint a fresh access token from the stored refresh token. `unavailable`: no
 * working connection (none, broken, or it changed meanwhile). `broken`: Google
 * refused the grant for good, or the sealing key is gone, and this call
 * recorded it. A transient Google failure throws and changes nothing.
 */
export async function mintAccessToken(
  env: Env,
  config: DriveConfig,
  actor: string,
): Promise<MintResult> {
  const row = await readConnection(env);
  if (!row || row.status !== 'connected' || !row.refreshTokenSealed)
    return { kind: 'unavailable' };

  const version = { revision: row.revision, sealed: row.refreshTokenSealed };
  let refreshToken: string;
  try {
    refreshToken = await unsealRefreshToken(
      config.tokenKey,
      row.refreshTokenSealed,
      { googleSub: row.googleSub, keyVersion: row.keyVersion },
    );
  } catch {
    // Sealed under a key this Worker no longer holds (spec review Q8: key
    // rotation is a reconnect).
    const marked = await markBroken(env, {
      ...version,
      reason: 'key-unavailable',
      actor,
    });
    return marked ? { kind: 'broken' } : { kind: 'unavailable' };
  }

  try {
    const minted = await refreshAccessToken(config, refreshToken);
    return { kind: 'minted', ...minted, version };
  } catch (err) {
    if (err instanceof GoogleTokenError && err.isPermanent) {
      const marked = await markBroken(env, {
        ...version,
        reason: err.code ?? 'invalid_grant',
        actor,
      });
      return marked ? { kind: 'broken' } : { kind: 'unavailable' };
    }
    throw err;
  }
}
