import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import {
  compareContexts,
  compareInShadow,
  recordMismatch,
} from '../../src/server/authz/shadow';
import type { AuthContext } from '../../src/server/authz/guards';

// ADR 0022 shadow comparison (issue #210, phase 2).

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const db = () => getDb(env);

beforeEach(async () => {
  for (const table of [
    'cutover_shadow_mismatches',
    'access_grants',
    'person_links',
    'person_verifications',
    'ownerships',
    'people',
    'parties',
  ]) {
    await db().run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db().run(sql.raw('DELETE FROM properties'));
});

async function account(id: string) {
  const now = new Date();
  await db()
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

const legacy = (overrides: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'a1',
  role: 'visitor',
  propertyIds: [],
  ...overrides,
});

describe('what counts as a mismatch', () => {
  it('matches when tier and lot set agree', () => {
    expect(
      compareContexts(
        legacy({ role: 'homeowner', propertyIds: ['l1', 'l2'] }),
        {
          contentTier: 'homeowner',
          lotIds: ['l2', 'l1'],
        },
      ).matched,
    ).toBe(true);
  });

  it('ignores ordering, which is an artifact of the query plan', () => {
    // Comparing arrays rather than sets here would report a mismatch on every
    // request and drown the real ones.
    expect(
      compareContexts(legacy({ propertyIds: ['b', 'a', 'c'] }), {
        contentTier: 'visitor',
        lotIds: ['c', 'a', 'b'],
      }).matched,
    ).toBe(true);
  });

  it('reports a tier disagreement', () => {
    const result = compareContexts(legacy({ role: 'board' }), {
      contentTier: 'visitor',
      lotIds: [],
    });
    expect(result.matched).toBe(false);
    expect(result.legacyRole).toBe('board');
    expect(result.derivedContentTier).toBe('visitor');
  });

  it('reports a lot-set disagreement of the same size', () => {
    // Same count, different lots — a size-only comparison would miss this.
    expect(
      compareContexts(legacy({ propertyIds: ['l1'] }), {
        contentTier: 'visitor',
        lotIds: ['l2'],
      }).matched,
    ).toBe(false);
  });
});

describe('recording', () => {
  it('writes counts and codes, never lot identifiers', async () => {
    await account('a1');
    await recordMismatch(
      env,
      'a1',
      'request',
      {
        matched: false,
        legacyRole: 'homeowner',
        derivedContentTier: 'visitor',
        legacyLotCount: 2,
        derivedLotCount: 0,
      },
      100,
    );
    const rows = await db().all<Record<string, unknown>>(
      sql`SELECT * FROM cutover_shadow_mismatches`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].legacy_lot_count).toBe(2);
    expect(rows[0].derived_lot_count).toBe(0);
    // Unexplained until an operator classifies it against the allow-list. A
    // NULL here blocks the flip, and nothing in the code may set it.
    expect(rows[0].explained_as).toBeNull();
    // No column should be able to hold a lot id or a personal value.
    expect(Object.keys(rows[0]).some((k) => k.includes('lot_id'))).toBe(false);
  });

  it('collapses repeats onto one row per account and source', async () => {
    // A caller hitting the site all day must not flood the table.
    await account('a1');
    const comparison = {
      matched: false,
      legacyRole: 'homeowner',
      derivedContentTier: 'visitor',
      legacyLotCount: 1,
      derivedLotCount: 0,
    };
    await recordMismatch(env, 'a1', 'request', comparison, 100);
    await recordMismatch(env, 'a1', 'request', comparison, 200);
    await recordMismatch(env, 'a1', 'request', comparison, 300);

    const rows = await db().all<{
      seen_count: number;
      first_seen_at: number;
      last_seen_at: number;
    }>(
      sql`SELECT seen_count, first_seen_at, last_seen_at FROM cutover_shadow_mismatches`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].seen_count).toBe(3);
    expect(rows[0].first_seen_at).toBe(100);
    expect(rows[0].last_seen_at).toBe(300);
  });

  it('keeps request and sweep observations separate', async () => {
    // The sweep is what makes the gate meaningful; conflating the two would
    // hide which evidence a row came from.
    await account('a1');
    const comparison = {
      matched: false,
      legacyRole: 'homeowner',
      derivedContentTier: 'visitor',
      legacyLotCount: 1,
      derivedLotCount: 0,
    };
    await recordMismatch(env, 'a1', 'request', comparison, 100);
    await recordMismatch(env, 'a1', 'sweep', comparison, 100);
    const rows = await db().all(sql`SELECT id FROM cutover_shadow_mismatches`);
    expect(rows).toHaveLength(2);
  });
});

describe('the shadow path cannot affect a request', () => {
  it('writes nothing when the two models agree', async () => {
    await account('a2');
    // Both say visitor with no lots: no link exists, and legacy has no links.
    await compareInShadow(env, legacy({ userId: 'a2' }), DAY);
    const rows = await db().all(sql`SELECT id FROM cutover_shadow_mismatches`);
    expect(rows).toEqual([]);
  });

  it('records a mismatch when legacy grants what derivation does not', async () => {
    // The accepted Member Access loss: a legacy link with no Person Link.
    await account('a3');
    await compareInShadow(
      env,
      legacy({ userId: 'a3', role: 'homeowner', propertyIds: ['lot-1'] }),
      DAY,
    );
    const rows = await db().all<{ account_id: string; legacy_role: string }>(
      sql`SELECT account_id, legacy_role FROM cutover_shadow_mismatches`,
    );
    expect(rows).toEqual([{ account_id: 'a3', legacy_role: 'homeowner' }]);
  });

  it('swallows a derivation failure instead of throwing', async () => {
    // Live authorization must never fail closed because the shadow model
    // failed. A transient D1 error here would otherwise present a linked board
    // member as anonymous and look exactly like a permissions bug.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      ...env,
      DATABASE: {
        batch: () => Promise.reject(new Error('D1 unavailable')),
        prepare: () => {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;

    await expect(
      compareInShadow(broken, legacy({ userId: 'a4' }), DAY),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('swallows a failure to record, too', async () => {
    // The write is as capable of failing as the read.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readOnly = {
      ...env,
      DATABASE: {
        batch: env.DATABASE.batch.bind(env.DATABASE),
        prepare: (query: string) =>
          query.includes('cutover_shadow_mismatches')
            ? { bind: () => ({ run: () => Promise.reject(new Error('nope')) }) }
            : env.DATABASE.prepare(query),
      },
    } as unknown as Env;

    await account('a5');
    await expect(
      compareInShadow(
        readOnly,
        legacy({ userId: 'a5', role: 'board', propertyIds: [] }),
        DAY,
      ),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
