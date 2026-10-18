import { driveConfig } from './config';
import { mintAccessToken } from './connection';
import { SCHEDULED_JOB_ACTOR } from './history';

/**
 * The daily Drive keepalive (#290 slice 2, spec decision 1). Minting an access
 * token counts as use of both the refresh token and the OAuth client, which
 * keeps both clear of Google's six-month inactivity limits. Runs whatever the
 * write freeze says (spec review Q10): it records only what Google decided.
 *
 * - `skipped`: not configured, or no working connection to keep alive.
 * - `refreshed`: Google minted a token; `last_refreshed_at` records when.
 * - `broken`: Google refused the grant for good; the connection is marked.
 * - throws: a transient failure, so the run shows red, with nothing changed.
 */
export async function driveKeepalive(
  env: Env,
): Promise<'skipped' | 'refreshed' | 'broken'> {
  const config = driveConfig(env);
  if (!config) return 'skipped';
  const result = await mintAccessToken(env, config, SCHEDULED_JOB_ACTOR);
  if (result.kind === 'unavailable') return 'skipped';
  if (result.kind === 'broken') return 'broken';
  await env.DATABASE.prepare(
    'UPDATE drive_connection SET last_refreshed_at = ? WHERE id = 1 AND revision = ? AND refresh_token_sealed = ?',
  )
    .bind(Date.now(), result.version.revision, result.version.sealed)
    .run();
  return 'refreshed';
}
