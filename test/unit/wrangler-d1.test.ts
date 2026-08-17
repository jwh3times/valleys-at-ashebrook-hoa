import { describe, it, expect, vi } from 'vitest';
import {
  chunkStatements,
  parseD1Output,
  withRetry,
} from '../../scripts/wrangler-d1';

// ADR 0022 phase 3f (#222): the wrangler-d1 output seam.
//
// The shapes below are captured from wrangler's own `d1 execute` code paths
// (wrangler-dist/cli.js): the query API prints one `{ results: [...] }` entry
// per statement, while remote `--file` goes through the IMPORT API and prints
// progress lines plus a single summary entry. The sweep crashed against the
// import shape in production, which is why the parser exists as a pure,
// testable seam rather than an inline JSON.parse.

const queryArray = JSON.stringify(
  [
    {
      results: [{ account_id: 'a1', has_board: 1 }],
      success: true,
      meta: { duration: 0.17 },
    },
    { results: [], success: true, meta: { duration: 0.02 } },
  ],
  null,
  2,
);

// Remote `--file`: what wrangler's executeRemotely() returns for the import
// path — ONE entry that also carries a `results` array, so shape alone cannot
// distinguish it from a one-statement query result.
const importSummary = JSON.stringify(
  [
    {
      results: [
        {
          'Total queries executed': 84,
          'Rows read': 120,
          'Rows written': 0,
          'Database size (MB)': '0.53',
        },
      ],
      success: true,
      finalBookmark: '00000085-00000000-00004ffe',
      meta: { served_by: 'v3-prod', duration: 312.5 },
    },
  ],
  null,
  2,
);

describe('parseD1Output', () => {
  it('returns per-statement results for a local --file array', () => {
    const outcome = parseD1Output(queryArray);
    expect(outcome.kind).toBe('statements');
    if (outcome.kind !== 'statements') return;
    expect(outcome.statements).toHaveLength(2);
    expect(outcome.statements[0].results).toEqual([
      { account_id: 'a1', has_board: 1 },
    ]);
    expect(outcome.statements[1].results).toEqual([]);
  });

  it('returns per-statement results for a remote --command array', () => {
    // The remote query API emits the same shape as local execution; only the
    // meta differs, and the parser must not care.
    const remote = JSON.stringify([
      {
        results: [{ lot_id: 'p1' }],
        success: true,
        meta: { served_by: 'v3-prod', duration: 40, rows_read: 3 },
      },
    ]);
    const outcome = parseD1Output(remote);
    expect(outcome.kind).toBe('statements');
    if (outcome.kind !== 'statements') return;
    expect(outcome.statements).toHaveLength(1);
  });

  it('refuses a remote import summary as typed, even with progress lines', () => {
    const raw = `├ Checking if file needs uploading\n🌀 File already uploaded. Processing.\n${importSummary}`;
    const outcome = parseD1Output(raw);
    expect(outcome.kind).toBe('import-summary');
  });

  it('refuses a clean import summary that mimics a one-statement result', () => {
    // The trap the marker detection exists for: an expected-count check alone
    // would accept this array of one and read the summary row as data.
    const outcome = parseD1Output(importSummary);
    expect(outcome.kind).toBe('import-summary');
  });

  it('refuses a --json error object as unrecognized', () => {
    const outcome = parseD1Output(
      JSON.stringify({ error: { text: 'no such table: nope' } }),
    );
    expect(outcome.kind).toBe('unrecognized');
  });

  it('refuses non-JSON output with the first line as detail', () => {
    const outcome = parseD1Output('Assertion failed: !(handle->flags)\nmore');
    expect(outcome.kind).toBe('not-json');
    if (outcome.kind !== 'not-json') return;
    expect(outcome.detail).toContain('Assertion failed');
  });

  it('refuses empty output rather than reading it as zero statements', () => {
    expect(parseD1Output('').kind).toBe('not-json');
  });
});

describe('chunkStatements', () => {
  it('preserves order and loses nothing', () => {
    const statements = ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4'];
    const chunks = chunkStatements(statements, 20);
    expect(chunks.flat()).toEqual(statements);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('keeps each chunk under the budget when statements fit', () => {
    const statements = Array.from({ length: 10 }, (_, i) => `SELECT ${i}`);
    for (const chunk of chunkStatements(statements, 30)) {
      expect(chunk.join(';\n').length).toBeLessThanOrEqual(30);
    }
  });

  it('never splits a statement, even one over budget', () => {
    const oversize = `SELECT '${'x'.repeat(100)}'`;
    const chunks = chunkStatements(['SELECT 1', oversize, 'SELECT 2'], 40);
    expect(chunks.flat()).toEqual(['SELECT 1', oversize, 'SELECT 2']);
    expect(chunks.some((c) => c.length === 1 && c[0] === oversize)).toBe(true);
  });

  it('returns no chunks for no statements', () => {
    expect(chunkStatements([], 100)).toEqual([]);
  });
});

describe('withRetry', () => {
  it('absorbs a transient failure and reports the retry', () => {
    // The Windows libuv exit-crash kills wrangler after the query completed;
    // one re-run is normally enough.
    let calls = 0;
    const onRetry = vi.fn();
    const value = withRetry(
      () => {
        calls += 1;
        if (calls < 3) throw new Error(`flake ${calls}`);
        return 'ok';
      },
      3,
      { onRetry },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith(2, expect.any(Error));
  });

  it('stops immediately on a failure the caller proves deterministic', () => {
    // A wrangler-reported SQL error is a real answer; re-running it three
    // times would only delay the red gate.
    let calls = 0;
    expect(() =>
      withRetry(
        () => {
          calls += 1;
          throw new Error('no such table: nope');
        },
        3,
        { shouldRetry: (e) => !(e instanceof Error) },
      ),
    ).toThrow('no such table');
    expect(calls).toBe(1);
  });

  it('rethrows the last error after the bound — a persistent failure still fails', () => {
    let calls = 0;
    expect(() =>
      withRetry(() => {
        calls += 1;
        throw new Error(`always ${calls}`);
      }, 3),
    ).toThrow('always 3');
    expect(calls).toBe(3);
  });

  it('does not retry a success', () => {
    const fn = vi.fn(() => 42);
    expect(withRetry(fn, 3)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
