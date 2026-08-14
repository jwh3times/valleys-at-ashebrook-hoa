import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { deriveAccess } from '../../src/server/authz/derive';
import { compareContexts } from '../../src/server/authz/shadow-compare';
import { legacyContext, resetRoster, seedRoster } from './dual-fixtures';

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
