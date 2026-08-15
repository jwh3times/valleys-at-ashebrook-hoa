import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { deriveAccess } from '../../src/server/authz/derive';
import { compareContexts } from '../../src/server/authz/shadow-compare';
import { legacyContext, resetRoster, seedRoster } from './dual-fixtures';
import { cutoverSettings } from '../../src/server/db/cutover-schema';

// Session plumbing is not what parity is testing, but the flag-driven half
// below has to go through `getAuthContext` — that is the seam whose behavior is
// in question — and `getAuthContext` starts by resolving a session.
const getSession = vi.hoisted(() => vi.fn());
vi.mock('../../src/server/auth', () => ({
  createAuth: vi.fn(() => ({ api: { getSession } })),
}));

import { getAuthContext } from '../../src/server/authz/context';

// The ADR 0022 parity suite (issue #210, phase 2).
//
// Both models, one fixture, every caller class. This is the evidence the flip
// gate rests on, so it asserts the EXPECTED answer on each side rather than
// only that the two agree — if they diverge, the failure says which one is
// wrong, not merely that they differ.
//
// Where the two are SUPPOSED to disagree, the divergence is asserted
// explicitly. Those cases are the pre-agreed allow-list, and there are exactly
// two of them; anything else is an unexplained mismatch and blocks the flip.

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await resetRoster();
  await getDb(env).run(sql.raw('DELETE FROM users'));
  await getDb(env).delete(cutoverSettings);
  getSession.mockReset();
});

describe('the two models agree', () => {
  it('for a verified member who owns one Lot', async () => {
    await seedRoster({
      lots: [{ id: 'lot-1', owners: [{ id: 'own-1', name: 'Jane Doe' }] }],
      accounts: [
        {
          id: 'acct-member',
          role: 'homeowner',
          legacyLots: ['lot-1'],
          linkedTo: 'own-1',
        },
      ],
    });

    const legacy = await legacyContext('acct-member');
    const derived = await deriveAccess(env, 'acct-member', DAY);

    expect(legacy).toEqual({ role: 'homeowner', propertyIds: ['lot-1'] });
    expect(derived.contentTier).toBe('homeowner');
    expect(derived.lotIds).toEqual(['lot-1']);
    expect(compareContexts(legacy, derived).matched).toBe(true);
  });

  it('for a member holding two Lots', async () => {
    await seedRoster({
      lots: [
        { id: 'lot-1', owners: [{ id: 'own-1', name: 'Jane Doe' }] },
        { id: 'lot-2', owners: [{ id: 'own-2', name: 'Jane Doe' }] },
      ],
      accounts: [
        {
          id: 'acct-two',
          role: 'homeowner',
          legacyLots: ['lot-1', 'lot-2'],
          linkedTo: 'own-1',
        },
      ],
    });
    // One Party per legacy owner row means the linked Person holds only lot-1.
    // The legacy account holds both, so this is a real divergence — and the
    // fixture makes it visible rather than hiding it behind a merge.
    const legacy = await legacyContext('acct-two');
    const derived = await deriveAccess(env, 'acct-two', DAY);
    expect(legacy.propertyIds.sort()).toEqual(['lot-1', 'lot-2']);
    expect(derived.lotIds).toEqual(['lot-1']);
    expect(compareContexts(legacy, derived).matched).toBe(false);
  });

  it('for an anonymous-equivalent account with nothing at all', async () => {
    await seedRoster({ accounts: [{ id: 'acct-empty' }] });

    const legacy = await legacyContext('acct-empty');
    const derived = await deriveAccess(env, 'acct-empty', DAY);

    expect(legacy).toEqual({ role: 'visitor', propertyIds: [] });
    expect(derived.contentTier).toBe('visitor');
    expect(compareContexts(legacy, derived).matched).toBe(true);
  });

  it('for a retired Lot, which neither model counts', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-gone',
          retired: true,
          owners: [{ id: 'own-g', name: 'Pat' }],
        },
      ],
      accounts: [
        {
          id: 'acct-retired',
          role: 'visitor',
          legacyLots: ['lot-gone'],
          linkedTo: 'own-g',
        },
      ],
    });

    const legacy = await legacyContext('acct-retired');
    const derived = await deriveAccess(env, 'acct-retired', DAY);

    // Legacy excludes it via `status`, derivation via `retired_at`.
    expect(legacy.propertyIds).toEqual([]);
    expect(derived.lotIds).toEqual([]);
    expect(compareContexts(legacy, derived).matched).toBe(true);
  });

  it('for a board member who also owns a Lot', async () => {
    await seedRoster({
      lots: [{ id: 'lot-3', owners: [{ id: 'own-3', name: 'Alex Board' }] }],
      accounts: [
        {
          id: 'acct-board-owner',
          role: 'board',
          legacyLots: ['lot-3'],
          linkedTo: 'own-3',
          grants: ['board'],
          boardTerm: {
            startDay: '2026-01-01',
            scheduledEndDay: '2027-01-01',
            lotId: 'lot-3',
          },
        },
      ],
    });

    const legacy = await legacyContext('acct-board-owner');
    const derived = await deriveAccess(env, 'acct-board-owner', DAY);

    expect(legacy).toEqual({ role: 'board', propertyIds: ['lot-3'] });
    expect(derived.contentTier).toBe('board');
    expect(derived.lotIds).toEqual(['lot-3']);
    expect(derived.capabilities.has('member')).toBe(true);
    expect(derived.hasCurrentBoardTerm).toBe(true);
    expect(compareContexts(legacy, derived).matched).toBe(true);
  });
});

describe('the allow-listed divergences, asserted explicitly', () => {
  it('accepted member access loss: a legacy link with no Person Link', async () => {
    // The mass re-verification case. Every homeowner loses access at the flip
    // and recovers it in minutes through ordinary verification.
    await seedRoster({
      lots: [{ id: 'lot-4', owners: [{ id: 'own-4', name: 'Sam' }] }],
      accounts: [
        { id: 'acct-unlinked', role: 'homeowner', legacyLots: ['lot-4'] },
      ],
    });

    const legacy = await legacyContext('acct-unlinked');
    const derived = await deriveAccess(env, 'acct-unlinked', DAY);

    expect(legacy).toEqual({ role: 'homeowner', propertyIds: ['lot-4'] });
    // No link means visitor — not "member with no lots".
    expect(derived.personId).toBeNull();
    expect(derived.contentTier).toBe('visitor');

    const comparison = compareContexts(legacy, derived);
    expect(comparison.matched).toBe(false);
    expect(comparison.legacyRole).toBe('homeowner');
    expect(comparison.derivedContentTier).toBe('visitor');
  });

  it('board callers lose the member pass-through when they own no Lot', async () => {
    // The named behavior change. Legacy `board >= homeowner` lets this caller
    // through the member-only gate with no association basis; derivation does
    // not. Both models still agree on the CONTENT tier, so this shows up as a
    // lot-set divergence, which is why the comparison checks both.
    await seedRoster({
      accounts: [
        {
          id: 'acct-board-only',
          role: 'board',
          linkedTo: undefined,
          grants: [],
        },
      ],
    });
    await seedRoster({
      lots: [{ id: 'lot-5', owners: [{ id: 'own-5', name: 'Casey' }] }],
    });
    await getDb(env).run(
      sql`INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
          VALUES ('v-bo', 'acct-board-only', 'own-5', 'manual', 'acct-board-only', 'manual_board_decision', 1)`,
    );
    await getDb(env).run(
      sql`INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
          VALUES ('l-bo', 'acct-board-only', 'own-5', 'v-bo', 1)`,
    );
    // The board member owns nothing: end the only Ownership their Person had.
    await getDb(env).run(sql`UPDATE ownerships SET end_day = '2026-01-01'`);
    await getDb(env).run(
      sql`INSERT INTO board_service_terms (id, person_id, start_day, scheduled_end_day, created_at, updated_at)
          VALUES ('t-bo', 'own-5', '2026-01-01', '2027-01-01', 1, 1)`,
    );
    await getDb(env).run(
      sql`INSERT INTO access_grants (id, account_id, grant_type, qualifying_board_term_id, started_at)
          VALUES ('g-bo', 'acct-board-only', 'board', 't-bo', 1)`,
    );

    const derived = await deriveAccess(env, 'acct-board-only', DAY);
    expect(derived.contentTier).toBe('board');
    expect(derived.capabilities.has('board')).toBe(true);
    // The whole point: board access without member access.
    expect(derived.capabilities.has('member')).toBe(false);
    expect(derived.lotIds).toEqual([]);
  });
});

describe('the fixture describes one world, not two', () => {
  it('writes both models from a single spec', async () => {
    // If this ever drifts, the parity suite compares two different setups and
    // reports agreement — a green test proving nothing.
    await seedRoster({
      lots: [
        {
          id: 'lot-6',
          owners: [
            { id: 'own-6', name: 'Robin', email: 'robin@example.test' },
            { id: 'own-7', name: 'Drew', active: false },
          ],
        },
      ],
    });
    const db = getDb(env);

    const legacyOwners = await db.all(
      sql`SELECT id FROM owners WHERE property_id = 'lot-6'`,
    );
    const parties = await db.all(
      sql`SELECT party_id FROM people WHERE party_id IN ('own-6', 'own-7')`,
    );
    expect(legacyOwners).toHaveLength(2);
    expect(parties).toHaveLength(2);

    // The inactive owner gets a Party but no Ownership, matching the backfill.
    const ownerships = await db.all<{ owner_party_id: string }>(
      sql`SELECT owner_party_id FROM ownerships WHERE lot_id = 'lot-6'`,
    );
    expect(ownerships).toEqual([{ owner_party_id: 'own-6' }]);
  });
});

/**
 * The same claim, driven by the flag rather than by calling each derivation
 * directly — the literal form of #206's "one parameterized parity suite run
 * against both derivations, for every caller class".
 *
 * The blocks above prove the two MODELS agree. This proves the SEAM delivers
 * the right one, which is a different failure: a correct derivation wired up
 * behind a flag that ignores it would pass every assertion above and still take
 * the site down at the flip.
 *
 * Every case resolves through `getAuthContext` with `cutover_mode` set, so what
 * is under test is exactly what a request gets.
 */
describe('the flag selects the model, for every caller class', () => {
  async function setMode(value: 'legacy' | 'derived') {
    const db = getDb(env);
    await db.delete(cutoverSettings);
    await db
      .insert(cutoverSettings)
      .values({ key: 'cutover_mode', value, updatedAt: new Date() });
  }

  /** Resolve one account the way a request would, under the given flag. */
  async function resolve(mode: 'legacy' | 'derived', accountId: string) {
    await setMode(mode);
    // The real Better Auth session carries the stored role, so read it from D1
    // rather than inventing one — otherwise the legacy half tests a fiction.
    const [row] = await getDb(env).all<{ role: string | null }>(
      sql`SELECT role FROM users WHERE id = ${accountId}`,
    );
    getSession.mockResolvedValue({
      user: { id: accountId, role: row?.role ?? null },
    });
    return getAuthContext(new Request('http://localhost'), env, DAY);
  }

  /** One world containing every caller class the flip has to survive. */
  async function seedEveryCallerClass() {
    await seedRoster({
      lots: [
        { id: 'lot-p1', owners: [{ id: 'own-p1', name: 'Mia Member' }] },
        { id: 'lot-p2', owners: [{ id: 'own-p2', name: 'Bo Board' }] },
        { id: 'lot-p3', owners: [{ id: 'own-p3', name: 'Sam Sysadmin' }] },
        { id: 'lot-p4', owners: [{ id: 'own-p4', name: 'Uma Unlinked' }] },
      ],
      accounts: [
        {
          id: 'acct-member',
          role: 'homeowner',
          legacyLots: ['lot-p1'],
          linkedTo: 'own-p1',
        },
        {
          id: 'acct-board-owner',
          role: 'board',
          legacyLots: ['lot-p2'],
          linkedTo: 'own-p2',
          grants: ['board'],
          boardTerm: {
            startDay: '2026-01-01',
            scheduledEndDay: '2027-01-01',
            lotId: 'lot-p2',
          },
        },
        {
          // Role `board` so both models agree on the tier: by the time a System
          // Administrator exists, flip step 6 has already granted them Board
          // Access, so a legacy `homeowner` here would test a state that never
          // occurs.
          id: 'acct-sysadmin',
          role: 'board',
          legacyLots: ['lot-p3'],
          linkedTo: 'own-p3',
          grants: ['system_admin'],
        },
        {
          // Verified under legacy, never linked in the new model. The accepted
          // Member Access loss, and the first of the two allow-list entries.
          id: 'acct-unlinked',
          role: 'homeowner',
          legacyLots: ['lot-p4'],
        },
      ],
    });
  }

  /**
   * `null` means "the models disagree here, deliberately" — the expectation is
   * asserted per mode instead.
   */
  const AGREEING: {
    account: string;
    tier: string;
    lots: string[];
    capabilities: string[];
  }[] = [
    {
      account: 'acct-member',
      tier: 'homeowner',
      lots: ['lot-p1'],
      capabilities: ['member'],
    },
    {
      account: 'acct-board-owner',
      tier: 'board',
      lots: ['lot-p2'],
      capabilities: ['board', 'member'],
    },
    {
      account: 'acct-sysadmin',
      tier: 'board',
      lots: ['lot-p3'],
      capabilities: ['board', 'member'],
    },
  ];

  beforeEach(seedEveryCallerClass);

  for (const mode of ['legacy', 'derived'] as const) {
    for (const { account, tier, lots, capabilities } of AGREEING) {
      it(`${account} resolves identically under ${mode}`, async () => {
        const ctx = await resolve(mode, account);
        expect(ctx?.contentTier).toBe(tier);
        expect([...(ctx?.lotIds ?? [])].sort()).toEqual([...lots].sort());
        for (const capability of capabilities) {
          expect(
            ctx?.capabilities.has(capability as never),
            `${account} should hold ${capability} under ${mode}`,
          ).toBe(true);
        }
        // The compatibility aliases must track, or every untouched call site
        // silently reads a different answer than the guards do.
        expect(ctx?.role).toBe(ctx?.contentTier);
        expect(ctx?.propertyIds).toEqual(ctx?.lotIds);
      });
    }

    it(`an anonymous caller is null under ${mode}`, async () => {
      await setMode(mode);
      getSession.mockResolvedValue(null);
      expect(
        await getAuthContext(new Request('http://localhost'), env, DAY),
      ).toBeNull();
    });
  }

  it('carries systemAdmin only under derived, which has the concept', async () => {
    expect(
      (await resolve('legacy', 'acct-sysadmin'))?.capabilities.has(
        'systemAdmin',
      ),
    ).toBe(false);
    expect(
      (await resolve('derived', 'acct-sysadmin'))?.capabilities.has(
        'systemAdmin',
      ),
    ).toBe(true);
  });

  it('loses the unlinked account its Lots exactly at the flip', async () => {
    // Allow-list entry one, asserted through the seam. Legacy honours the
    // verification link; derived has no Person Link to honour.
    const legacy = await resolve('legacy', 'acct-unlinked');
    expect(legacy?.contentTier).toBe('homeowner');
    expect(legacy?.lotIds).toEqual(['lot-p4']);

    const derived = await resolve('derived', 'acct-unlinked');
    expect(derived?.contentTier).toBe('visitor');
    expect(derived?.lotIds).toEqual([]);
    // Authenticated, so still a context — the gates answer 403, not 401.
    expect(derived).not.toBeNull();
  });

  it('reverses on the way back, so the abort path is real', async () => {
    // Rolling `cutover_mode` back must restore the previous answer on the next
    // request. Nothing is cached, which is what makes that true.
    expect((await resolve('derived', 'acct-unlinked'))?.contentTier).toBe(
      'visitor',
    );
    expect((await resolve('legacy', 'acct-unlinked'))?.contentTier).toBe(
      'homeowner',
    );
  });
});
