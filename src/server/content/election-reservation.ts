/**
 * The reservation protocol shared by every multi-statement election
 * transition — `setTallies`, `setBallots` and `certify`.
 *
 * D1 has no interactive transactions, so a transition that must replace a set
 * of child rows cannot hold a lock across statements. Instead each of these
 * actions:
 *
 *   1. writes a SENTINEL status onto the election, conditioned on the status
 *      it observed — this is the reservation, and it either wins or changes
 *      zero rows;
 *   2. gates EVERY child statement on that sentinel still being present;
 *   3. restores or advances the status, again conditioned on the sentinel;
 *   4. inspects only the first and last statement.
 *
 * Because `db.batch()` is a single transaction, the sentinel is never
 * externally visible or committed. A terminal transition (certify, void) that
 * wins first makes the reservation a no-op, and every child is then a no-op
 * too, so the whole batch lands as nothing rather than half-applied.
 *
 * The protocol used to be restated in prose at all three call sites, with the
 * step-2 guard hand-copied EIGHT times in slightly different shapes. Missing
 * it on one child fails silently — that statement simply writes
 * unconditionally — which is exactly the kind of mistake a seam should make
 * impossible rather than reviewable.
 */

/**
 * Sentinel statuses. These are deliberately NOT members of `ElectionStatus`:
 * they exist only inside an uncommitted batch, and no reader should ever be
 * able to observe one. `schema.ts` has no CHECK constraint on
 * `elections.status`, so nothing but the atomicity of `db.batch()` keeps one
 * out of a committed row — which is precisely why the protocol lives in one
 * place instead of three.
 */
export const RESERVATION_SENTINELS = {
  tallies: '__replacing_tallies__',
  ballots: '__replacing_ballots__',
  certify: '__certifying__',
} as const;

export type ReservationSentinel =
  (typeof RESERVATION_SENTINELS)[keyof typeof RESERVATION_SENTINELS];

export interface ReservationGuard {
  /** Append to a child statement's WHERE clause. */
  sql: string;
  /** Append to that statement's binds, in order. */
  binds: [string, string];
}

/**
 * The step-2 guard: "the reservation I took is still held".
 *
 * It checks the sentinel alone, not `source` as well. That is sufficient and
 * not a weakening: the sentinel is unique per action and only the reservation
 * statement can set it, so observing it already implies every condition the
 * reservation required — including `source = 'recorded'` where that applied.
 */
export function reservationGuard(
  electionId: string,
  sentinel: ReservationSentinel,
): ReservationGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM elections WHERE id = ? AND status = ?)`,
    binds: [electionId, sentinel],
  };
}

/**
 * Runs `[reserve, ...children, release]` as one batch and reports whether the
 * transition committed.
 *
 * **The release must be conditioned on the sentinel and nothing narrower.**
 * `db.batch()` rolls back on an ERROR, not on a statement that matches zero
 * rows — so a release carrying an extra predicate that could fail would
 * commit the sentinel into `elections.status`, where no reader expects a
 * value outside `ElectionStatus`. Conditioning it on `id = ? AND status =
 * <sentinel>` alone makes it unmissable: the reservation set exactly that,
 * one statement earlier, in the same transaction.
 *
 * `election-reservation.test.ts` pins both halves — that a well-formed
 * release always lands, and that a release which cannot match strands the
 * sentinel, which is why the rule exists.
 *
 * `false` means the reservation or the release changed no rows — something
 * else moved the election first — and, because every child was gated on the
 * sentinel, nothing was written. Callers turn that into their own 409; the
 * message differs per action, so it is not this module's business.
 */
export async function runReservedBatch(
  database: D1Database,
  reserve: D1PreparedStatement,
  children: D1PreparedStatement[],
  release: D1PreparedStatement,
): Promise<boolean> {
  const results = await database.batch([reserve, ...children, release]);
  // Only the ends are inspected: a child changing zero rows is legitimate
  // (a full replace with nothing to insert), while the reservation and the
  // release changing zero rows is exactly what losing the race looks like.
  return (
    results[0].meta.changes === 1 &&
    results[results.length - 1].meta.changes === 1
  );
}
