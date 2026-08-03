import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { proxies } from '../db/schema';

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
