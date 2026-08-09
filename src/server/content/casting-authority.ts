import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { userPropertyLinks } from '../db/schema';

export interface CastingAuthority {
  /**
   * Every lot this caller is verified for, read from `user_property_links`.
   *
   * Deliberately NOT filtered by `properties.status`. Voting eligibility is
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
 * This exists because the answer had two implementations that disagreed. The
 * cast path read `user_property_links` directly (correct, snapshot-governed),
 * while the read model behind `/vote` used `AuthContext.propertyIds`, which
 * `getAuthContext` inner-joins against `properties` and filters to
 * `status = 'active'` — the right rule for general homeowner access, the wrong
 * one here. A lot deactivated after an occasion opened vanished from `/vote`
 * while `POST /api/vote` still accepted it.
 *
 * Both paths now derive `ownLots` from here. The mutation SQL still repeats
 * the predicate independently at the write boundary; that duplication is the
 * deliberate ADR 0020 layer and is not what this module replaces.
 */
export async function resolveCastingAuthority(
  db: Db,
  userId: string,
): Promise<CastingAuthority> {
  const rows = await db
    .select({ propertyId: userPropertyLinks.propertyId })
    .from(userPropertyLinks)
    .where(eq(userPropertyLinks.userId, userId));
  return { ownLots: new Set(rows.map((row) => row.propertyId)) };
}
