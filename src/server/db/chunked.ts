/**
 * D1 permits at most 100 bound parameters per query. Any read that binds one
 * parameter per row of a prior result — the `inArray(col, rows.map(...))`
 * shape — therefore has a hard ceiling, and exceeding it fails the request
 * rather than merely slowing it down.
 *
 * This lives here, next to the client, rather than beside any one caller: the
 * limit is a property of D1, not of the table being read. Before this module
 * the rule was a private const inside a single function in `content/reads.ts`,
 * and two sibling reads in that same file were written without it.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * Runs `query` over `ids` in batches that stay inside D1's bound-parameter
 * limit and concatenates the results.
 *
 * The caller keeps its own query shape — joins, `groupBy`, projections — and
 * only gives up ownership of the batching. Duplicate ids are collapsed before
 * batching, which is safe for the `IN (...)` semantics every call site uses
 * and can save a round trip.
 *
 * Two constraints a caller must know:
 *
 * - `query` runs once per batch, so results are ordered within a batch but not
 *   across batches. Fine for building a `Map` keyed by id, which is what every
 *   current caller does; NOT fine for a query whose `ORDER BY` must hold over
 *   the whole result, and never combine it with a global `LIMIT`/`OFFSET`.
 * - `chunkSize` counts the ids only. A query that binds further parameters
 *   (an extra `eq(...)`, a tier list) must lower it by that many, or the batch
 *   can still exceed the limit.
 */
export async function chunkedIn<Id, Row>(
  ids: readonly Id[],
  query: (batch: Id[]) => Promise<Row[]>,
  chunkSize: number = D1_MAX_BOUND_PARAMS,
): Promise<Row[]> {
  if (chunkSize < 1) throw new Error('chunkSize must be at least 1');
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length <= chunkSize) return query(unique);

  const rows: Row[] = [];
  for (let start = 0; start < unique.length; start += chunkSize) {
    rows.push(...(await query(unique.slice(start, start + chunkSize))));
  }
  return rows;
}
