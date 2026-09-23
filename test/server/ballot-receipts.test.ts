import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  organizations,
  parties,
  personLinks,
  personVerifications,
  representationLots,
  representations,
  ownerships as ownershipsTable,
} from '../../src/server/db/roster-schema';
import { properties, proxies } from '../../src/server/db/schema';
import { deriveAccess } from '../../src/server/authz/derive';
import {
  now,
  seedBallot,
  seedElection,
  seedLotAuthority,
  seedProperty,
  truncateAll,
} from './fixtures';
import { fetchPaperBallotReceipts } from '../../src/server/content/ballot-receipts';
import type { AuthContext } from '../../src/server/authz/guards';

/**
 * #302 slice 2. The receipt is caller-specific and selection-free: it answers
 * "is this lot recorded as having returned a ballot", for lots the caller held
 * ON THE ELECTION'S DAY, and nothing else. The scoping lives inside the SQL,
 * never as a filter after the read, so these tests care as much about what
 * does NOT come back as about what does.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// Order is forced by the schema. `organizations` and `ownerships` both
// reference `parties` with RESTRICT, so both must go before `truncateAll`
// reaches the party rows — otherwise one representation test poisons every
// test after it.
const CLEAR = [
  'person_links',
  'person_verifications',
  'representation_lots',
  'representations',
  'access_grants',
  'board_service_terms',
  'ownerships',
  'organizations',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) await db.run(sql.raw(`DELETE FROM "${table}"`));
  // `parties.consolidated_into_party_id` self-references with RESTRICT, which
  // SQLite enforces immediately rather than at end of statement, so a
  // surviving pointer blocks `truncateAll`'s party delete.
  await db.run(sql.raw('UPDATE parties SET consolidated_into_party_id = NULL'));
  await truncateAll();
  await db.run(sql.raw('DELETE FROM users'));
  await db.insert(users).values({
    id: 'acct-1',
    name: 'acct-1',
    email: 'acct-1@example.test',
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
});

const ELECTION_DAY = '2026-03-01';

async function linkAccount(accountId: string, personId: string) {
  const db = getDb(env);
  await db.insert(personVerifications).values({
    id: `ver-${accountId}`,
    accountId,
    personId,
    method: 'manual',
    approverAccountId: accountId,
    reason: 'manual_board_decision',
    verifiedAt: now,
  });
  await db.insert(personLinks).values({
    id: `link-${accountId}`,
    accountId,
    personId,
    verificationId: `ver-${accountId}`,
    startedAt: now,
  });
}

function memberCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'acct-1',
    personId: 'per-1',
    capabilities: new Set(['member']),
    lotIds: [],
    contentTier: 'homeowner',
    hasCurrentBoardTerm: false,
    ...overrides,
  } as AuthContext;
}

/** The subset of an election the read takes. */
function electionArg(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    electionDate: ELECTION_DAY,
    source: 'recorded' as const,
    ...overrides,
  };
}

/** An Organization the caller represents, owning `lotId` across the election. */
async function seedRepresentedLot(
  orgId: string,
  lotId: string,
  scopeKind: 'organization' | 'lots',
  overrides: { startDay?: string; endDay?: string | null } = {},
) {
  const db = getDb(env);
  await db.insert(parties).values({
    id: orgId,
    kind: 'organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(organizations).values({
    partyId: orgId,
    partyKind: 'organization',
    legalName: `Org ${orgId}`,
    nameNormalized: `org ${orgId}`,
    updatedAt: now,
  });
  await db.insert(ownershipsTable).values({
    id: `${orgId}-${lotId}-own`,
    ownerPartyId: orgId,
    lotId,
    startDay: '2025-01-01',
    endDay: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(representations).values({
    id: `rep-${orgId}-${lotId}`,
    representativePersonId: 'per-1',
    organizationPartyId: orgId,
    scopeKind,
    startDay: overrides.startDay ?? '2025-01-01',
    endDay: overrides.endDay ?? null,
    createdAt: now,
    updatedAt: now,
  });
  if (scopeKind === 'lots')
    await db.insert(representationLots).values({
      representationId: `rep-${orgId}-${lotId}`,
      lotId,
      voidedAt: null,
      createdAt: now,
    });
}

describe('fetchPaperBallotReceipts', () => {
  it('reports a recorded ballot for a lot the caller held on the election day', async () => {
    await seedProperty('lot-1');
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });
    await seedBallot('b1', 'e1', 'lot-1');

    const receipts = await fetchPaperBallotReceipts(env, memberCtx(), [
      electionArg('e1'),
    ]);

    expect(receipts.get('e1')).toEqual([
      { address: 'lot-1 Ashebrook Lane', recorded: true },
    ]);
  });

  it('reports no ballot for a held lot that returned none', async () => {
    await seedProperty('lot-1');
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });

    const receipts = await fetchPaperBallotReceipts(env, memberCtx(), [
      electionArg('e1'),
    ]);

    // Absence is a real state the homeowner can dispute, not an error.
    expect(receipts.get('e1')).toEqual([
      { address: 'lot-1 Ashebrook Lane', recorded: false },
    ]);
  });

  it('never mentions a lot the caller does not hold', async () => {
    await seedProperty('lot-1');
    await seedProperty('lot-2');
    await seedProperty('lot-3');
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });
    // A neighbour who returned a ballot, and one who did not: neither surfaces.
    await seedBallot('b2', 'e1', 'lot-2');

    const rows = (
      await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
    ).get('e1')!;

    expect(rows.map((r) => r.address)).toEqual(['lot-1 Ashebrook Lane']);
    // No lot id, weight, proxy or caster provenance, or recording time.
    expect(Object.keys(rows[0]).sort()).toEqual(['address', 'recorded']);
  });

  describe('lot authority is read on the election day, not today', () => {
    it('omits a lot whose ownership ended before the election', async () => {
      await seedProperty('lot-1');
      await seedProperty('lot-2');
      await seedLotAuthority('per-1', 'lot-1', {
        startDay: '2025-01-01',
        endDay: '2026-02-01',
      });
      // Still a member today, through a lot bought later.
      await seedLotAuthority('per-1', 'lot-2', { startDay: '2026-06-01' });
      await linkAccount('acct-1', 'per-1');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      expect(rows).toEqual([]);
    });

    it('omits a lot bought after the election', async () => {
      await seedProperty('lot-1');
      await seedLotAuthority('per-1', 'lot-1', { startDay: '2026-06-01' });
      await linkAccount('acct-1', 'per-1');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });
      await seedBallot('b1', 'e1', 'lot-1');

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      // The previous holder's participation is not the buyer's to learn.
      expect(rows).toEqual([]);
    });

    it('still shows a lot sold after the election', async () => {
      await seedProperty('lot-1');
      await seedProperty('lot-2');
      await seedLotAuthority('per-1', 'lot-1', {
        startDay: '2025-01-01',
        endDay: '2026-05-01',
      });
      await seedLotAuthority('per-1', 'lot-2', { startDay: '2025-01-01' });
      await linkAccount('acct-1', 'per-1');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });
      await seedBallot('b1', 'e1', 'lot-1');

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      // The ballot was their act.
      expect(rows).toContainEqual({
        address: 'lot-1 Ashebrook Lane',
        recorded: true,
      });
    });

    it('counts a backdated ownership starting on the election day', async () => {
      await seedProperty('lot-1');
      await seedLotAuthority('per-1', 'lot-1', { startDay: ELECTION_DAY });
      await linkAccount('acct-1', 'per-1');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });
      await seedBallot('b1', 'e1', 'lot-1');

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      expect(rows).toEqual([
        { address: 'lot-1 Ashebrook Lane', recorded: true },
      ]);
    });
  });

  describe('representation', () => {
    it('includes an organization-scoped represented lot', async () => {
      await seedProperty('lot-1');
      await seedProperty('lot-9');
      await seedLotAuthority('per-1', 'lot-9', { startDay: '2025-01-01' });
      await linkAccount('acct-1', 'per-1');
      await seedRepresentedLot('org-1', 'lot-1', 'organization');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });
      await seedBallot('b1', 'e1', 'lot-1');

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      expect(rows).toContainEqual({
        address: 'lot-1 Ashebrook Lane',
        recorded: true,
      });
    });

    it('includes a lot-scoped represented lot', async () => {
      await seedProperty('lot-1');
      await seedProperty('lot-9');
      await seedLotAuthority('per-1', 'lot-9', { startDay: '2025-01-01' });
      await linkAccount('acct-1', 'per-1');
      await seedRepresentedLot('org-1', 'lot-1', 'lots');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      expect(rows).toContainEqual({
        address: 'lot-1 Ashebrook Lane',
        recorded: false,
      });
    });

    it('omits a representation that ended before the election day', async () => {
      await seedProperty('lot-1');
      await seedProperty('lot-9');
      await seedLotAuthority('per-1', 'lot-9', { startDay: '2025-01-01' });
      await linkAccount('acct-1', 'per-1');
      await seedRepresentedLot('org-1', 'lot-1', 'organization', {
        endDay: '2026-02-01',
      });
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });
      await seedBallot('b1', 'e1', 'lot-1');

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      expect(rows.map((r) => r.address)).not.toContain('lot-1 Ashebrook Lane');
    });

    it('omits a voided lot-scope row', async () => {
      await seedProperty('lot-1');
      await seedProperty('lot-9');
      await seedLotAuthority('per-1', 'lot-9', { startDay: '2025-01-01' });
      await linkAccount('acct-1', 'per-1');
      await seedRepresentedLot('org-1', 'lot-1', 'lots');
      await getDb(env).run(
        sql`UPDATE representation_lots SET voided_at = 1 WHERE lot_id = 'lot-1'`,
      );
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'closed',
        visibility: 'public',
      });

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      expect(rows.map((r) => r.address)).not.toContain('lot-1 Ashebrook Lane');
    });
  });

  it('agrees with deriveAccess on the election day, so one definition of the caller lot set survives', async () => {
    await seedProperty('lot-1');
    await seedProperty('lot-2');
    await seedProperty('lot-retired', { retiredAt: now });
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await seedLotAuthority('per-1', 'lot-retired', { startDay: '2025-01-01' });
    // A consolidated duplicate Party, whose ownership must still resolve.
    await seedLotAuthority('per-dup', 'lot-2', { startDay: '2025-01-01' });
    await getDb(env).run(
      sql`UPDATE parties SET consolidated_into_party_id = 'per-1' WHERE id = 'per-dup'`,
    );
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });

    const derived = await deriveAccess(env, 'acct-1', ELECTION_DAY);
    const rows = (
      await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
    ).get('e1')!;

    const all = await getDb(env)
      .select({ id: properties.id, address: properties.address })
      .from(properties);
    const expected = all
      .filter((p) => derived.lotIds.includes(p.id))
      .map((p) => p.address)
      .sort();
    expect(rows.map((r) => r.address).sort()).toEqual(expected);
  });

  describe('which elections answer at all', () => {
    for (const status of ['draft', 'void'] as const) {
      it(`returns nothing for a ${status} election even when passed directly`, async () => {
        await seedProperty('lot-1');
        await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
        await linkAccount('acct-1', 'per-1');
        await seedElection('e1', {
          electionDate: ELECTION_DAY,
          status,
          visibility: 'public',
        });
        await seedBallot('b1', 'e1', 'lot-1');

        const rows = (
          await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
        ).get('e1')!;
        expect(rows).toEqual([]);
      });
    }

    it('returns nothing for a conducted election', async () => {
      await seedProperty('lot-1');
      await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
      await linkAccount('acct-1', 'per-1');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'certified',
        visibility: 'public',
        source: 'conducted',
      });
      await seedBallot('b1', 'e1', 'lot-1');

      const receipts = await fetchPaperBallotReceipts(env, memberCtx(), [
        electionArg('e1', { source: 'conducted' }),
      ]);
      // Conducted ballots are final; the correction process does not apply.
      expect(receipts.has('e1')).toBe(false);
    });

    it('answers for a certified recorded election', async () => {
      await seedProperty('lot-1');
      await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
      await linkAccount('acct-1', 'per-1');
      await seedElection('e1', {
        electionDate: ELECTION_DAY,
        status: 'certified',
        visibility: 'public',
      });
      await seedBallot('b1', 'e1', 'lot-1');

      const rows = (
        await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
      ).get('e1')!;
      expect(rows).toEqual([
        { address: 'lot-1 Ashebrook Lane', recorded: true },
      ]);
    });
  });

  it('gives a homeowner-tier caller nothing for a board-visibility election', async () => {
    await seedProperty('lot-1');
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'board',
    });
    await seedBallot('b1', 'e1', 'lot-1');

    const rows = (
      await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
    ).get('e1')!;
    expect(rows).toEqual([]);
  });

  it('answers a board caller who holds lots', async () => {
    await seedProperty('lot-1');
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'board',
    });
    await seedBallot('b1', 'e1', 'lot-1');

    const rows = (
      await fetchPaperBallotReceipts(
        env,
        memberCtx({
          capabilities: new Set(['member', 'board']),
          contentTier: 'board',
        }),
        [electionArg('e1')],
      )
    ).get('e1')!;
    expect(rows).toEqual([{ address: 'lot-1 Ashebrook Lane', recorded: true }]);
  });

  it('returns nothing when the election date moved under the read', async () => {
    await seedProperty('lot-1');
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: '2026-04-15',
      status: 'closed',
      visibility: 'public',
    });
    await seedBallot('b1', 'e1', 'lot-1');

    // The page read the old date; the board has since edited it. Zero rows
    // this render rather than an answer for the wrong day.
    const rows = (
      await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
    ).get('e1')!;
    expect(rows).toEqual([]);
  });

  it('gives a proxy holder no receipt for the granting lot', async () => {
    await seedProperty('lot-1');
    await seedProperty('lot-2');
    // The caller holds lot-2, and merely HOLDS A PROXY over lot-1.
    await seedLotAuthority('per-1', 'lot-2', { startDay: '2025-01-01' });
    await seedLotAuthority('per-grantor', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });
    await getDb(env).insert(proxies).values({
      id: 'px-1',
      propertyId: 'lot-1',
      grantorPersonId: 'per-grantor',
      holderName: 'Person per-1',
      holderPersonId: 'per-1',
      electionId: 'e1',
      meetingId: null,
      createdBy: 'acct-1',
      createdAt: now,
      updatedAt: now,
    });
    await seedBallot('b1', 'e1', 'lot-1', { proxyId: 'px-1' });

    const rows = (
      await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
    ).get('e1')!;
    // The grantor holds the authority and can check it themselves.
    expect(rows.map((r) => r.address)).toEqual(['lot-2 Ashebrook Lane']);
    expect(JSON.stringify(rows)).not.toContain('px-1');
    expect(JSON.stringify(rows)).not.toContain('per-grantor');
  });

  it('gives an unlinked account an empty result', async () => {
    await seedProperty('lot-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });
    await seedBallot('b1', 'e1', 'lot-1');

    const rows = (
      await fetchPaperBallotReceipts(env, memberCtx(), [electionArg('e1')])
    ).get('e1')!;
    // No Person Link, so LOT_SQL yields nothing. This is also what
    // cutover_mode = legacy looks like: no link rows drive access there.
    expect(rows).toEqual([]);
  });

  it('gives a caller without the member capability an empty map', async () => {
    await seedProperty('lot-1');
    await seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });
    await seedBallot('b1', 'e1', 'lot-1');

    const receipts = await fetchPaperBallotReceipts(
      env,
      memberCtx({ capabilities: new Set() }),
      [electionArg('e1')],
    );
    expect(receipts.size).toBe(0);
  });
});
