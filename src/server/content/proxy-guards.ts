import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { proxies, memberAttendance, memberVotes, ballots } from '../db/schema';

export interface ProxyUse {
  propertyId: string;
  proxyId: string;
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
