import { describe, it, expect, vi } from 'vitest';
import { chunkedIn, D1_MAX_BOUND_PARAMS } from '../../src/server/db/chunked';

describe('chunkedIn', () => {
  it('does not query at all for an empty id list', async () => {
    const query = vi.fn();
    expect(await chunkedIn([], query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('issues a single query when the ids fit inside one batch', async () => {
    const query = vi.fn(async (batch: number[]) => batch.map((n) => n * 2));
    expect(await chunkedIn([1, 2, 3], query)).toEqual([2, 4, 6]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('splits past the limit and concatenates every batch', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i);
    const batches: number[][] = [];
    const rows = await chunkedIn(ids, async (batch) => {
      batches.push(batch);
      return batch;
    });

    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    // Nothing dropped, nothing duplicated, order preserved across batches.
    expect(rows).toEqual(ids);
  });

  it('never exceeds the limit in a single batch', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await chunkedIn(ids, async (batch) => {
      expect(batch.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      return [];
    });
  });

  it('collapses duplicate ids before batching', async () => {
    const query = vi.fn(async (batch: string[]) => batch);
    const rows = await chunkedIn(['a', 'b', 'a', 'b', 'a'], query);
    expect(rows).toEqual(['a', 'b']);
    expect(query).toHaveBeenCalledWith(['a', 'b']);
  });

  it('honours a caller-lowered chunk size, for queries that bind extras', async () => {
    const batches: number[][] = [];
    await chunkedIn(
      [1, 2, 3, 4, 5],
      async (batch) => {
        batches.push(batch);
        return [];
      },
      2,
    );
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('rejects a chunk size that could never make progress', async () => {
    await expect(chunkedIn([1, 2], async () => [], 0)).rejects.toThrow(
      'chunkSize must be at least 1',
    );
  });
});
