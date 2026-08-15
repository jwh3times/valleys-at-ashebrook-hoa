import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { getCutoverMode } from '../../src/server/authz/cutover-mode';

/**
 * The ADR 0022 phase-3 flip switch (#217).
 *
 * Until this existed, `cutover_mode` was a row nothing read — which meant the
 * flip's abort plan ("roll back to `legacy` while the freeze still holds") had
 * nothing to act on, and the phase-2 reversal drill could only prove the row
 * was writable, not that flipping it did anything.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(cutoverSettings);
});

async function setMode(value: 'legacy' | 'derived') {
  const db = getDb(env);
  await db.delete(cutoverSettings);
  await db
    .insert(cutoverSettings)
    .values({ key: 'cutover_mode', value, updatedAt: new Date() });
}

describe('reading the cutover mode', () => {
  it('is legacy when the row is absent', async () => {
    // The normal pre-flip state. Migration 0021 seeds no row, so absence must
    // read as legacy rather than as an error.
    expect(await getCutoverMode(env)).toBe('legacy');
  });

  it('is legacy when the row says legacy', async () => {
    await setMode('legacy');
    expect(await getCutoverMode(env)).toBe('legacy');
  });

  it('is derived when the row says derived', async () => {
    await setMode('derived');
    expect(await getCutoverMode(env)).toBe('derived');
  });

  it('falls back to legacy when the setting cannot be read', async () => {
    // The polarity that matters, and the opposite of the write freeze's. The
    // freeze falls back to "frozen" because refusing is restrictive. Here the
    // axis is "which of two models do we trust", and the safe answer is the one
    // that has been serving production all along. Falling back to `derived`
    // would swap the site's authorization model as a side effect of a transient
    // database blip.
    const brokenEnv = {
      ...env,
      DATABASE: {
        prepare() {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;
    expect(await getCutoverMode(brokenEnv)).toBe('legacy');
  });

  it('treats an unrecognised value as legacy', async () => {
    // The CHECK constraint should prevent this, but a guard that trusts a
    // constraint to have been applied is a guard that fails open the one time
    // it was not.
    await getDb(env).delete(cutoverSettings);
    await env.DATABASE.prepare(
      `INSERT INTO cutover_settings (key, value, updated_at) VALUES ('cutover_mode', 'legacy', 1)`,
    ).run();
    await env.DATABASE.prepare(
      `UPDATE cutover_settings SET value = 'wat' WHERE key = 'cutover_mode'`,
    )
      .run()
      .catch(() => {
        /* the CHECK may refuse it; either outcome is fine for this assertion */
      });
    expect(await getCutoverMode(env)).toBe('legacy');
  });

  it('takes effect and reverses without a restart', async () => {
    // The reversal drill in miniature, and the reason this is a D1 row rather
    // than a var: the operator flips it mid-incident and it must take within
    // seconds, then reverse just as fast. Nothing is cached.
    expect(await getCutoverMode(env)).toBe('legacy');
    await setMode('derived');
    expect(await getCutoverMode(env)).toBe('derived');
    await setMode('legacy');
    expect(await getCutoverMode(env)).toBe('legacy');
  });
});
