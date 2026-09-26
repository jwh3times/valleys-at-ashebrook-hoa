import { eq } from 'drizzle-orm';
import { associationDateIso } from '../../lib/format';
import type { AuthContext } from '../authz/guards';
import type { Db } from '../db/client';
import { parties } from '../db/roster-schema';
import {
  fetchPersonAuthority,
  lotAuthorityExists,
  type AuthoritySql,
  type SqlRef,
} from '../roster/authority';

export interface CastingAuthority {
  /**
   * Every lot this caller holds casting authority for.
   *
   * Deliberately NOT filtered by `lots.status`. Voting eligibility is
   * decided by the frozen `election_eligibility` / `motion_eligibility`
   * snapshot taken when the occasion opened — [ADR 0020](../../../docs/adr/0020-digital-ballot-box.md):
   * "later roster, property-status, or weight changes do not alter who was
   * eligible". A lot deactivated mid-occasion is therefore still votable, and
   * the snapshot, not this set, is what refuses an ineligible lot.
   */
  ownLots: Set<string>;
}

/**
 * Resolves which lots a caller may act for.
 *
 * Resolves a consolidated linked Person one hop to the survivor,
 * then re-reads that Person's Lot Authority rather than using
 * `AuthContext.lotIds`, which excludes retired Lots. Voting instead lets the
 * frozen eligibility snapshot decide whether a Lot still counts after the
 * occasion opens.
 *
 * The read model and preflight both derive `ownLots` here. The mutation SQL
 * still repeats the predicate independently at the write boundary; that
 * duplication is the deliberate ADR 0020 layer and is not what this module
 * replaces.
 */
export async function resolveCastingAuthority(
  db: Db,
  ctx: AuthContext,
): Promise<CastingAuthority> {
  if (ctx.personId !== null) {
    const partyRows = await db
      .select({
        id: parties.id,
        consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
      })
      .from(parties)
      .where(eq(parties.id, ctx.personId))
      .limit(1);
    const party = partyRows[0];
    if (party === undefined) return { ownLots: new Set() };
    const rows = await fetchPersonAuthority(
      db,
      party.consolidatedIntoPartyId ?? party.id,
      associationDateIso(),
    );
    return { ownLots: new Set(rows.map((row) => row.lotId)) };
  }

  return { ownLots: new Set() };
}

/**
 * Mutation-boundary counterpart to `resolveCastingAuthority` for one Lot.
 *
 * Each request re-checks both halves of the capability: the Account's
 * current Person Link must still name the same Person resolved into the
 * request context; its one-hop canonical survivor must still hold Lot
 * Authority.
 */
export function castingAuthorityExists(
  ctx: AuthContext,
  lot: SqlRef,
  day: string,
): AuthoritySql {
  if (ctx.personId === null) return { sql: '0', binds: [] };

  const authority = lotAuthorityExists(
    {
      column:
        'COALESCE(casting_person_party.consolidated_into_party_id, casting_person_link.person_id)',
    },
    lot,
    day,
  );
  return {
    sql: `EXISTS (
      SELECT 1
      FROM person_links casting_person_link
      INNER JOIN parties casting_person_party
        ON casting_person_party.id = casting_person_link.person_id
      WHERE casting_person_link.account_id = ?
        AND casting_person_link.person_id = ?
        AND casting_person_link.ended_at IS NULL
        AND ${authority.sql}
    )`,
    binds: [ctx.userId, ctx.personId, ...authority.binds],
  };
}

/**
 * Whether `person` holds Lot Authority over at least one Lot the caller may
 * cast for. This is the mutation-boundary definition of holding a proxy: the
 * proxy names its holder Person, while the signed-in Account's canonical
 * Person reaches that holder through a Lot both control. The holder remains
 * uncanonicalized because the proxy names who acted, not which Person the
 * Account represents.
 */
export function personSharesCastingAuthority(
  ctx: AuthContext,
  person: SqlRef,
  day: string,
): AuthoritySql {
  if (ctx.personId === null) return { sql: '0', binds: [] };

  const caller = lotAuthorityExists(
    {
      column:
        'COALESCE(casting_person_party.consolidated_into_party_id, casting_person_link.person_id)',
    },
    { column: 'casting_lot.lot_id' },
    day,
  );
  const holder = lotAuthorityExists(
    person,
    { column: 'casting_lot.lot_id' },
    day,
  );
  return {
    sql: `EXISTS (
      SELECT 1
      FROM person_links casting_person_link
      INNER JOIN parties casting_person_party
        ON casting_person_party.id = casting_person_link.person_id
      WHERE casting_person_link.account_id = ?
        AND casting_person_link.person_id = ?
        AND casting_person_link.ended_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM ownerships casting_lot
          WHERE ${caller.sql}
            AND ${holder.sql}
        )
    )`,
    binds: [ctx.userId, ctx.personId, ...caller.binds, ...holder.binds],
  };
}
