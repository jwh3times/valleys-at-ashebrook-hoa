import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { proxies, memberAttendance, memberVotes, ballots } from '../db/schema';
import { people } from '../db/roster-schema';
import { associationDateIso } from '../../lib/format';
import { authorityKey, fetchLotAuthorityKeys } from '../roster/authority';

/**
 * GRANTOR RE-VALIDATION (ADR 0022 phase 3d, #220 / #204).
 *
 * `proxyUseError` below asks, in addition to lot and occasion scope, whether
 * the proxy's GRANTOR still holds Lot Authority.
 *
 * Until #248 part 2 that question was answered from the LEGACY roster
 * (`owners.status` / `owners.property_id`) in both cutover modes, because a
 * proxy named a legacy owner row and no runtime mapping existed from one to a
 * Party. Migration `0029` re-keyed `proxies.grantor_person_id` to
 * `people(party_id)`, so the question is now the roster's own, asked through
 * the shared `roster/authority.ts` definition — the same rule
 * `qualifiesGuard` applies to a Board Term's qualifying Lot.
 *
 * The roster records intervals, but this comparison is still made at TODAY's
 * Association Day rather than the occasion's, so the approximation #220
 * documented survives the repointing: a grantor who sold AFTER the occasion
 * still fails, even though the proxy was good on the day. That deliberately
 * accepts false refusals of late record-keeping, because the alternative
 * (accepting every proxy from a former owner) is the March-proxy /
 * April-meeting / recorded-in-May hole #204 opens with. The escape for a
 * legitimate late entry is to record it without the proxy reference.
 *
 * Exact occasion-day containment is now MECHANICALLY possible for the first
 * time — the intervals are queryable and the day is on the occasion row — and
 * is deliberately left to its own change rather than folded into a schema
 * repointing, since it moves a safety-critical guard's semantics rather than
 * its storage. For a LIVE cast the occasion is now, so `voting.ts`'s
 * mutation-boundary predicate is already exact.
 */

export interface ProxyUse {
  propertyId: string;
  proxyId: string;
}

/**
 * Which column an entry names its acting Person in. `member_attendance` calls
 * it `represented_by_person_id`, `member_votes` and `ballots` call it
 * `cast_by_person_id`; the rule about it is identical in all three.
 */
export type ProvenancePersonKey = 'castByPersonId' | 'representedByPersonId';

export interface Provenance {
  proxyId: string | null;
  personId: string | null;
}

/**
 * Reads the "who acted for this lot" pair off one entry of a full-replace
 * payload: an optional proxy reference and an optional Person reference, at
 * most one of them.
 *
 * The mutual exclusion is the ADR 0018 invariant — who acted lives on the
 * (board-only) proxy row, never beside it, because a row carrying both could
 * name two different people and the public read would leak the holder. It was
 * written out three times, once per route, and drifted only in the field name;
 * `viaProxy` is derived from `proxy_id`, so this is the only place the pairing
 * is decided.
 */
export function parseProvenance(
  record: Record<string, unknown> | null,
  personKey: ProvenancePersonKey,
): { ok: true; value: Provenance } | { ok: false; error: string } {
  const rawPersonId = record?.[personKey];
  if (
    rawPersonId !== undefined &&
    rawPersonId !== null &&
    typeof rawPersonId !== 'string'
  ) {
    return { ok: false, error: `${personKey} must be a string when present` };
  }
  const rawProxyId = record?.proxyId;
  if (
    rawProxyId !== undefined &&
    rawProxyId !== null &&
    typeof rawProxyId !== 'string'
  ) {
    return { ok: false, error: 'proxyId must be a string when present' };
  }
  const proxyId = typeof rawProxyId === 'string' ? rawProxyId : null;
  const personId = typeof rawPersonId === 'string' ? rawPersonId : null;
  if (proxyId !== null && personId !== null) {
    return {
      ok: false,
      error: `An entry cannot carry both proxyId and ${personKey} — who acted lives on the proxy record`,
    };
  }
  return { ok: true, value: { proxyId, personId } };
}

/**
 * Which field a route reports an unknown Person under. The two provenance
 * columns `parseProvenance` reads, plus the plain `personId` the BOARD
 * roll-call actions carry — those name a Person directly rather than beside a
 * proxy, so they are deliberately not `ProvenancePersonKey`s: widening that
 * type instead would let `parseProvenance` be asked for a `personId` field,
 * which no provenance payload has.
 */
export type PersonFieldName = ProvenancePersonKey | 'personId';

/**
 * Rejects an entry set naming a Person that does not exist.
 *
 * Five entry-set columns across the meeting record and the elections record
 * reference `people(party_id)`, and D1 enforces every one — so without this an
 * unknown id leaves the route as a raw FOREIGN KEY error from inside the batch,
 * i.e. an unhandled 500, rather than a 400:
 *
 * - `member_attendance.represented_by_person_id` (`setMemberAttendance`)
 * - `member_votes.cast_by_person_id` (`setMemberVotes`)
 * - `ballots.cast_by_person_id` (`setBallots`)
 * - `board_attendance.person_id` (`setAttendance`)
 * - `board_votes.person_id` (`setVotes`)
 *
 * The last two are NOT NULL and were the hole #234 reported: they reached the
 * FK unchecked, so the admin UI could not tell "you sent a stale person id"
 * from "the server broke". Both became `people(party_id)` FKs in #248 part 1;
 * before that they referenced the retired `board_people`, which is why the
 * check written for the provenance columns did not already cover them.
 *
 * Existence only, deliberately: whether that Person could plausibly have acted
 * for the lot is a judgement the board makes when entering a paper record,
 * which may legitimately be back-dated past a transfer. The proxy path is
 * stricter because a proxy asserts a delegation that must have been the
 * grantor's to give.
 */
export async function personExistenceError(
  db: Db,
  personIds: (string | null)[],
  personKey: PersonFieldName,
): Promise<{ status: 400; message: string } | null> {
  const ids = [...new Set(personIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return null;
  const rows = await db
    .select({ id: people.partyId })
    .from(people)
    .where(inArray(people.partyId, ids));
  if (rows.length === ids.length) return null;
  return { status: 400, message: `Unknown ${personKey} in entries` };
}

export interface ProxyUseFailure {
  status: 400 | 409;
  message: string;
}

/**
 * Validates every proxy referenced by a write action's entries: the proxy
 * must exist, belong to the entry's own lot, be scoped to the occasion
 * being written, and have a grantor who still holds Lot Authority for that
 * lot. `occasion` carries the meeting or election under write; an
 * election held at a meeting passes BOTH ids, because a form signed "for the
 * annual meeting" covers that meeting's business, its election included —
 * the lookup rule ADR 0018 records. The database cannot express any of this
 * (each is a cross-row condition), which is why this guard exists in front of
 * every insert that writes a proxy_id.
 *
 * The grantor check is the ADR 0022 phase-3d addition; see the module comment
 * above for which day it asks about and what that still approximates.
 */
export async function proxyUseError(
  db: Db,
  uses: ProxyUse[],
  occasion: { meetingId?: string | null; electionId?: string | null },
): Promise<ProxyUseFailure | null> {
  if (uses.length === 0) return null;
  const ids = [...new Set(uses.map((u) => u.proxyId))];
  const rows = await db
    .select({
      id: proxies.id,
      propertyId: proxies.propertyId,
      meetingId: proxies.meetingId,
      electionId: proxies.electionId,
      grantorPersonId: proxies.grantorPersonId,
    })
    .from(proxies)
    .where(inArray(proxies.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // One roster read for every lot named by a proxy under write, rather than
  // one per proxy: a full-replace payload carries an entry per lot.
  const authority = await fetchLotAuthorityKeys(
    db,
    [...new Set(rows.map((r) => r.propertyId))],
    associationDateIso(),
  );
  for (const u of uses) {
    const p = byId.get(u.proxyId);
    if (!p) return { status: 400, message: 'Unknown proxyId in entries' };
    if (p.propertyId !== u.propertyId)
      return { status: 409, message: 'Proxy is for a different lot' };
    if (!authority.has(authorityKey(p.grantorPersonId, p.propertyId)))
      return {
        status: 409,
        message: 'Proxy grantor no longer holds authority for this lot',
      };
    const coversMeeting =
      p.meetingId !== null &&
      occasion.meetingId != null &&
      p.meetingId === occasion.meetingId;
    const coversElection =
      p.electionId !== null &&
      occasion.electionId != null &&
      p.electionId === occasion.electionId;
    if (!coversMeeting && !coversElection)
      return {
        status: 409,
        message: 'Proxy is scoped to a different occasion',
      };
  }
  return null;
}

/**
 * True if this lot already holds a proxy for the given occasion — the same
 * condition proxies_property_meeting_unq / proxies_property_election_unq
 * enforce, pre-checked so the route can answer a readable 409 instead of a
 * raw D1 unique-constraint error. Exactly one of meetingId/electionId is
 * non-null (callers validate that before calling).
 */
export async function duplicateProxyExists(
  db: Db,
  propertyId: string,
  meetingId: string | null,
  electionId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ id: proxies.id })
    .from(proxies)
    .where(
      and(
        eq(proxies.propertyId, propertyId),
        meetingId != null
          ? eq(proxies.meetingId, meetingId)
          : eq(proxies.electionId, electionId!),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Which record tables still cite this proxy. proxy_id carries no ON DELETE
 * action (ADR 0018 — and, since migration 0029 rebuilt these tables, by
 * decision rather than by drizzle-kit's ALTER-column trap), so deletes must
 * pre-check all three citing tables to answer deterministically rather than
 * surface a raw D1 FK error. An empty result means the proxy is unused and
 * deletable — deletion is the entire revocation model.
 */
export async function proxyUseLabels(
  db: Db,
  proxyId: string,
): Promise<string[]> {
  const [attRows, voteRows, ballotRows] = await Promise.all([
    db
      .select({ id: memberAttendance.id })
      .from(memberAttendance)
      .where(eq(memberAttendance.proxyId, proxyId))
      .limit(1),
    db
      .select({ id: memberVotes.id })
      .from(memberVotes)
      .where(eq(memberVotes.proxyId, proxyId))
      .limit(1),
    db
      .select({ id: ballots.id })
      .from(ballots)
      .where(eq(ballots.proxyId, proxyId))
      .limit(1),
  ]);
  return [
    ...(attRows.length > 0 ? ['attendance'] : []),
    ...(voteRows.length > 0 ? ['votes'] : []),
    ...(ballotRows.length > 0 ? ['ballots'] : []),
  ];
}
