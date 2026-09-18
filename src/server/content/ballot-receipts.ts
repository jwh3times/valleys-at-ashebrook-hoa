import { LOT_SQL } from '../authz/derive';
import type { AuthContext } from '../authz/guards';

/**
 * The paper-ballot receipt (#302, ADR 0026).
 *
 * A verified homeowner may ask ONE question about a lot they held on a
 * recorded election's day: is that lot recorded as having returned a ballot?
 * Not what the ballot said — a recorded election stores no link from a ballot
 * to a candidate anywhere (ADR 0017) — and never anything about a lot they did
 * not hold.
 *
 * This is a sibling of `voting-reads.ts` rather than an export of `reads.ts`,
 * because its signature fits none of the three shapes
 * `reads-all-scoped.test.ts` classifies.
 *
 * **Why it does not reuse the conducted receipt's scoping.** `/vote`'s
 * `hasCast` scopes through `resolveCastingAuthority`, which reads
 * `user_property_links` — a legacy write-behind mirror that ADR 0022 phase 4
 * (#212) drops. Reusing it would add a consumer to a table on its way out.
 * This module embeds `LOT_SQL` itself, so there stays exactly ONE definition
 * of "the caller's Lots", including Representation, one-hop consolidation, and
 * retired-lot exclusion.
 */

export interface PaperBallotReceiptLot {
  address: string;
  recorded: boolean;
}

/** Keyed by election id. An election absent from the map yields no receipt block. */
export type PaperBallotReceipts = Map<string, PaperBallotReceiptLot[]>;

/** The election fields this read needs. Deliberately not the whole detail. */
export interface ReceiptElection {
  id: string;
  electionDate: string;
  source: string;
}

/**
 * The tier predicate, chosen from the caller's content tier as a fixed
 * literal — never interpolated from anything a caller supplied. Mirrors
 * `visibilityPredicate` in `voting.ts`.
 */
function visibilityPredicate(alias: string, tier: AuthContext['role']): string {
  if (tier === 'board') return '1 = 1';
  if (tier === 'homeowner')
    return `${alias}.visibility IN ('public', 'homeowner')`;
  return '0 = 1';
}

/**
 * One statement per visible recorded election, all in one D1 batch. Elections
 * happen about once a year, so the batch stays small.
 *
 * Every constraint that makes the answer safe is INSIDE the statement:
 *
 * - the lot set is `LOT_SQL` as a subquery, bound to the caller's account and
 *   to the election's own Association Day, so a caller-controlled list cannot
 *   widen it;
 * - `source`, `status` and the tier predicate are re-checked here, so even a
 *   wrong id list yields zero rows rather than confirming a hidden election;
 * - `e.election_date = ?2` guards the race where the board edits the date
 *   between the page's read and this one — zero rows this render, correct on
 *   the next;
 * - `recorded` is an EXISTS for that single (election, lot) pair. The query
 *   never selects a `ballots` column and never lists another lot.
 *
 * Only `address` and `recorded` come back: no lot id, weight, `proxy_id`,
 * `cast_by_person_id`, or `recorded_at`. Results are never logged.
 */
export async function fetchPaperBallotReceipts(
  env: Env,
  ctx: AuthContext,
  elections: ReceiptElection[],
): Promise<PaperBallotReceipts> {
  const empty: PaperBallotReceipts = new Map();
  // Repeats the page's own check. An anonymous caller, an unlinked account,
  // and a board member who holds no lot all get nothing, matching the member
  // surfaces' capability semantics.
  if (!ctx.capabilities.has('member')) return empty;

  const recorded = elections.filter((e) => e.source === 'recorded');
  if (recorded.length === 0) return empty;

  const tierSql = visibilityPredicate('e', ctx.contentTier);
  const statements = recorded.map((election) =>
    env.DATABASE.prepare(
      `SELECT p.address AS address,
              EXISTS (
                SELECT 1 FROM ballots b
                WHERE b.election_id = e.id AND b.property_id = p.id
              ) AS recorded
         FROM elections e
         JOIN properties p ON p.id IN (${LOT_SQL})
        WHERE e.id = ?3
          AND e.election_date = ?2
          AND e.source = 'recorded'
          AND e.status IN ('closed', 'certified')
          AND ${tierSql}
        ORDER BY p.address, p.id`,
    ).bind(ctx.userId, election.electionDate, election.id),
  );

  const results = await env.DATABASE.batch<{
    address: string;
    recorded: number;
  }>(statements);

  const receipts: PaperBallotReceipts = new Map();
  results.forEach((result, index) => {
    receipts.set(
      recorded[index].id,
      result.results.map((row) => ({
        address: row.address,
        recorded: row.recorded === 1,
      })),
    );
  });
  return receipts;
}
