import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { ownerships, people, representations } from '../db/roster-schema';
import { personDisplayLabel } from '../../lib/format';

/**
 * WHO MAY ACT FOR A LOT (#248 part 2).
 *
 * The meeting, elections, and proxies records name who acted — the attendee
 * who represented a lot, the person who cast a ballot, a proxy's grantor and
 * holder. Until migration `0029` those columns referenced the legacy `owners`
 * table, and the question was answered by `owners.status = 'active'` plus
 * `owners.property_id`. They now reference `people(party_id)`, so the question
 * is the roster's: does this Person hold Lot Authority over this Lot?
 *
 * That question already had an authoritative definition —
 * `board-consequences.ts`'s `qualifiesGuard`, which decides whether a Board
 * Term's qualifying basis still stands. This module deliberately mirrors it
 * rather than inventing a second rule: Lot Authority is one concept, and a
 * proxy grantor who qualifies for a board seat through a Lot but may not sign
 * for it would be incoherent. Ownership held by the Person, or Representation
 * of an Organization that owns the Lot, on the given Association Day.
 *
 * Two expressions of it live here, for the two layers this repo separates on
 * purpose (ADR 0020): a Drizzle reader for preflight checks and pickers, and a
 * raw-SQL fragment for the mutation-boundary predicates that re-check the same
 * thing inside the INSERT. They must agree, and keeping them adjacent is what
 * makes a divergence visible.
 *
 * Consolidated duplicate Parties are deliberately NOT canonicalized here, and
 * retired Lots are deliberately not excluded — both matching `qualifiesGuard`.
 * A consolidated Party still holds the Ownership row that grants the authority,
 * and the Lot in question is already fixed by the record being written.
 */

/** A Person holding Lot Authority over one Lot, with its display label. */
export interface LotAuthorityHolder {
  personId: string;
  lotId: string;
  fullName: string;
}

/** Stable key for "this Person, this Lot" membership tests. */
export const authorityKey = (personId: string, lotId: string) =>
  `${personId}:${lotId}`;

/** What to narrow an authority read to. An empty filter reads every authority
 * relationship in the association — see `fetchAllLotAuthority`. */
interface AuthorityFilter {
  lotIds?: string[];
  personId?: string;
}

/**
 * The (Person, Lot) pairs in which Lot Authority is held on `day`.
 *
 * Organizations are excluded structurally rather than by a filter: both
 * branches join `people`, whose rows are the Person subtype of `parties`. An
 * Organization owner reaches this list only through its Representative, which
 * is the path ADR 0022 routes entity authority down.
 */
async function queryAuthority(
  db: Db,
  filter: AuthorityFilter,
  day: string | null,
): Promise<LotAuthorityHolder[]> {
  const lotIds = filter.lotIds;
  if (lotIds !== undefined && lotIds.length === 0) return [];
  const lotFilter =
    lotIds === undefined ? undefined : inArray(ownerships.lotId, lotIds);
  // `day === null` asks "did this authority EVER exist", dropping the interval
  // comparison while keeping the voided filter — a voided row was recorded in
  // error and never granted anything. Used by the board's record-keeping
  // pickers, which must still offer a former owner for a past occasion.
  const currentOwnership =
    day === null
      ? isNull(ownerships.voidedAt)
      : and(
          isNull(ownerships.voidedAt),
          or(isNull(ownerships.startDay), lte(ownerships.startDay, day)),
          or(isNull(ownerships.endDay), gt(ownerships.endDay, day)),
        );

  const owned = await db
    .select({
      personId: ownerships.ownerPartyId,
      lotId: ownerships.lotId,
      fullName: people.fullName,
    })
    .from(ownerships)
    .innerJoin(people, eq(people.partyId, ownerships.ownerPartyId))
    .where(
      and(
        lotFilter,
        filter.personId === undefined
          ? undefined
          : eq(ownerships.ownerPartyId, filter.personId),
        currentOwnership,
      ),
    );

  const represented = await db
    .select({
      personId: representations.representativePersonId,
      lotId: ownerships.lotId,
      fullName: people.fullName,
    })
    .from(representations)
    .innerJoin(
      ownerships,
      and(
        eq(ownerships.ownerPartyId, representations.organizationPartyId),
        lotFilter,
        currentOwnership,
      ),
    )
    .innerJoin(
      people,
      eq(people.partyId, representations.representativePersonId),
    )
    .where(
      and(
        filter.personId === undefined
          ? undefined
          : eq(representations.representativePersonId, filter.personId),
        isNull(representations.voidedAt),
        day === null ? undefined : lte(representations.startDay, day),
        day === null
          ? undefined
          : or(isNull(representations.endDay), gt(representations.endDay, day)),
        or(
          eq(representations.scopeKind, 'organization'),
          // Scope rows are voided on correction, never deleted, so the
          // voided_at filter is what makes a corrected scope stop granting.
          sql`EXISTS (
            SELECT 1 FROM representation_lots rl
            WHERE rl.representation_id = ${representations.id}
              AND rl.lot_id = ${ownerships.lotId}
              AND rl.voided_at IS NULL
          )`,
        ),
      ),
    );

  const seen = new Set<string>();
  const out: LotAuthorityHolder[] = [];
  for (const row of [...owned, ...represented]) {
    const key = authorityKey(row.personId, row.lotId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      personId: row.personId,
      lotId: row.lotId,
      // A redacted Person renders the same durable-ID fallback here as on
      // every other Person read — a surface with its own fallback is a bug.
      fullName: personDisplayLabel(row.fullName, row.personId),
    });
  }
  return out.sort(
    (a, b) =>
      a.fullName.localeCompare(b.fullName) ||
      a.personId.localeCompare(b.personId),
  );
}

/** Every Person holding Lot Authority over any of `lotIds` on `day`. */
export function fetchLotAuthority(
  db: Db,
  lotIds: string[],
  day: string,
): Promise<LotAuthorityHolder[]> {
  return queryAuthority(db, { lotIds }, day);
}

/**
 * Every Lot this one Person holds authority over on `day`.
 *
 * Answers "may this Person be named as a proxy holder at all?", which is a
 * question about the Person rather than about any particular lot — a holder
 * need not have any connection to the lot whose proxy they hold.
 */
export function fetchPersonAuthority(
  db: Db,
  personId: string,
  day: string,
): Promise<LotAuthorityHolder[]> {
  return queryAuthority(db, { personId }, day);
}

/**
 * Every (Person, Lot) authority pair in the association on `day`.
 *
 * Deliberately unfiltered, for the board's per-lot record-keeping pickers,
 * which need every lot's answer at once. Board-gated at its call sites — this
 * is the whole association's authority map, which no member surface may read.
 */
export function fetchAllLotAuthority(
  db: Db,
  day: string,
): Promise<LotAuthorityHolder[]> {
  return queryAuthority(db, {}, day);
}

/**
 * Every (Person, Lot) authority pair that has EVER existed, each flagged with
 * whether it still holds on `day`.
 *
 * The board's member attendance, member vote, ballot, and proxy pickers all
 * need the historic list: a meeting held last spring was attended by whoever
 * held the lot then, and a paper proxy signed before a sale is still a record
 * worth entering. `current` is what those surfaces warn on — a proxy from a
 * former owner is accepted at entry and refused at USE (see
 * content/proxy-guards.ts).
 */
export async function fetchLotAuthorityHistory(
  db: Db,
  day: string,
): Promise<(LotAuthorityHolder & { current: boolean })[]> {
  const [ever, current] = await Promise.all([
    queryAuthority(db, {}, null),
    queryAuthority(db, {}, day),
  ]);
  const currentKeys = new Set(
    current.map((r) => authorityKey(r.personId, r.lotId)),
  );
  return ever.map((r) => ({
    ...r,
    current: currentKeys.has(authorityKey(r.personId, r.lotId)),
  }));
}

/**
 * Whether this Person has ever held Lot Authority over this Lot.
 *
 * The entry-time question for a proxy grantor, deliberately weaker than the
 * use-time one: a grantor from a different lot is a data-entry error worth
 * refusing, while a grantor who has since sold is a historical record worth
 * keeping (ADR 0018 / #220).
 */
export async function hasEverHeldLotAuthority(
  db: Db,
  personId: string,
  lotId: string,
): Promise<boolean> {
  const rows = await queryAuthority(db, { personId, lotIds: [lotId] }, null);
  return rows.length > 0;
}

/** Membership set of `authorityKey`s, for "may this Person act here?". */
export async function fetchLotAuthorityKeys(
  db: Db,
  lotIds: string[],
  day: string,
): Promise<Set<string>> {
  const rows = await fetchLotAuthority(db, lotIds, day);
  return new Set(rows.map((r) => authorityKey(r.personId, r.lotId)));
}

/**
 * A SQL operand the caller supplies: a column reference embedded verbatim, or
 * a value bound as a parameter.
 */
export type SqlRef = { column: string } | { value: string | null };

export interface AuthoritySql {
  sql: string;
  binds: unknown[];
}

/**
 * `(EXISTS (…) OR EXISTS (…))` for "this Person holds Lot Authority over this
 * Lot on `day`", for embedding in a mutation-boundary predicate.
 *
 * The Drizzle reader above is the same rule; this exists because the casting
 * SQL re-checks authority inside its own INSERT, where a preflight answer
 * computed a round trip earlier is exactly what a race invalidates.
 *
 * `binds` come back in placeholder order — a `{ value }` operand binds once per
 * occurrence, and `day` binds six times, because the interval comparison
 * repeats it. Splice them into the statement's bind list at the position this
 * fragment occupies.
 */
export function lotAuthorityExists(
  person: SqlRef,
  lot: SqlRef,
  day: string,
): AuthoritySql {
  const binds: unknown[] = [];
  const ref = (operand: SqlRef): string => {
    if ('column' in operand) return operand.column;
    binds.push(operand.value);
    return '?';
  };
  const dayRef = (): string => {
    binds.push(day);
    return '?';
  };
  // Every operand is interpolated exactly where its placeholder appears, and
  // template literals evaluate left to right, so `binds` ends up in placeholder
  // order without a separate ordering step to keep in sync.
  const text = `(
        EXISTS (
          SELECT 1 FROM ownerships authority_own
          WHERE authority_own.owner_party_id = ${ref(person)}
            AND authority_own.lot_id = ${ref(lot)}
            AND authority_own.voided_at IS NULL
            AND (authority_own.start_day IS NULL OR authority_own.start_day <= ${dayRef()})
            AND (authority_own.end_day IS NULL OR ${dayRef()} < authority_own.end_day)
        )
        OR EXISTS (
          SELECT 1 FROM representations authority_rep
          INNER JOIN ownerships authority_org_own
            ON authority_org_own.owner_party_id = authority_rep.organization_party_id
           AND authority_org_own.lot_id = ${ref(lot)}
           AND authority_org_own.voided_at IS NULL
           AND (authority_org_own.start_day IS NULL OR authority_org_own.start_day <= ${dayRef()})
           AND (authority_org_own.end_day IS NULL OR ${dayRef()} < authority_org_own.end_day)
          WHERE authority_rep.representative_person_id = ${ref(person)}
            AND authority_rep.voided_at IS NULL
            AND authority_rep.start_day <= ${dayRef()}
            AND (authority_rep.end_day IS NULL OR ${dayRef()} < authority_rep.end_day)
            AND (
              authority_rep.scope_kind = 'organization'
              OR EXISTS (
                SELECT 1 FROM representation_lots authority_rl
                WHERE authority_rl.representation_id = authority_rep.id
                  AND authority_rl.lot_id = ${ref(lot)}
                  AND authority_rl.voided_at IS NULL
              )
            )
        )
      )`;
  return { sql: text, binds };
}
