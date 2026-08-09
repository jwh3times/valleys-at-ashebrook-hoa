import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  proxies,
  memberAttendance,
  memberVotes,
  ballots,
  owners,
} from '../db/schema';

export interface ProxyUse {
  propertyId: string;
  proxyId: string;
}

/**
 * Which column an entry names its acting owner in. `member_attendance` calls
 * it `represented_by_owner_id`, `member_votes` and `ballots` call it
 * `cast_by_owner_id`; the rule about it is identical in all three.
 */
export type ProvenanceOwnerKey = 'castByOwnerId' | 'representedByOwnerId';

export interface Provenance {
  proxyId: string | null;
  ownerId: string | null;
}

/**
 * Reads the "who acted for this lot" pair off one entry of a full-replace
 * payload: an optional proxy reference and an optional owner reference, at
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
  ownerKey: ProvenanceOwnerKey,
): { ok: true; value: Provenance } | { ok: false; error: string } {
  const rawOwnerId = record?.[ownerKey];
  if (
    rawOwnerId !== undefined &&
    rawOwnerId !== null &&
    typeof rawOwnerId !== 'string'
  ) {
    return { ok: false, error: `${ownerKey} must be a string when present` };
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
  const ownerId = typeof rawOwnerId === 'string' ? rawOwnerId : null;
  if (proxyId !== null && ownerId !== null) {
    return {
      ok: false,
      error: `An entry cannot carry both proxyId and ${ownerKey} — who acted lives on the proxy record`,
    };
  }
  return { ok: true, value: { proxyId, ownerId } };
}

/**
 * Rejects an entry set naming an owner that does not exist.
 *
 * `member_attendance.represented_by_owner_id`, `member_votes.cast_by_owner_id`
 * and `ballots.cast_by_owner_id` are all real FKs to `owners`, and D1 enforces
 * them — so without this an unknown id leaves the route as a raw FOREIGN KEY
 * error from inside the batch, i.e. an unhandled 500, rather than a 400. Only
 * `setBallots` pre-checked it; the two sibling routes writing the byte-identical
 * field did not.
 */
export async function ownerExistenceError(
  db: Db,
  ownerIds: (string | null)[],
  ownerKey: ProvenanceOwnerKey,
): Promise<{ status: 400; message: string } | null> {
  const ids = [...new Set(ownerIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return null;
  const rows = await db
    .select({ id: owners.id })
    .from(owners)
    .where(inArray(owners.id, ids));
  if (rows.length === ids.length) return null;
  return { status: 400, message: `Unknown ${ownerKey} in entries` };
}

export interface ProxyUseFailure {
  status: 400 | 409;
  message: string;
}

/**
 * Validates every proxy referenced by a write action's entries: the proxy
 * must exist, belong to the entry's own lot, and be scoped to the occasion
 * being written. `occasion` carries the meeting or election under write; an
 * election held at a meeting passes BOTH ids, because a form signed "for the
 * annual meeting" covers that meeting's business, its election included —
 * the lookup rule ADR 0018 records. The database cannot express any of this
 * (each is a cross-row condition), which is why this guard exists in front of
 * every insert that writes a proxy_id.
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
    })
    .from(proxies)
    .where(inArray(proxies.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const u of uses) {
    const p = byId.get(u.proxyId);
    if (!p) return { status: 400, message: 'Unknown proxyId in entries' };
    if (p.propertyId !== u.propertyId)
      return { status: 409, message: 'Proxy is for a different lot' };
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
 * action (ADR 0018 — ALTER-added FK), so deletes must pre-check all three
 * citing tables to answer deterministically rather than surface a raw D1
 * FK error. An empty result means the proxy is unused and deletable —
 * deletion is the entire revocation model.
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
