// Shared helpers for scripts that spawn `wrangler d1 execute` and read its
// output. Pure — nothing here touches `child_process` — so every decision that
// could misread a database answer is unit-testable against captured output
// shapes without spawning anything.
//
// WHY THE PARSER EXISTS. `wrangler d1 execute --json` has two output regimes
// that look nothing alike. `--command` (and local `--file`) go through the D1
// QUERY API and print one JSON array with one `{ results: [...] }` entry per
// statement, in order. Remote `--file` goes through the D1 IMPORT API instead:
// it prints non-JSON progress lines ("├ Checking if file needs uploading")
// followed by a single summary object with no per-statement results. A script
// that indexes per-statement results over import-API output either crashes at
// JSON.parse or — worse — mis-indexes and reads garbage as green. The parser
// makes the distinction typed: callers get per-statement results or a refusal
// naming the shape, never a silent misread.

export interface D1StatementResult<T = unknown> {
  results?: T[];
}

export type D1ParseOutcome =
  | { kind: 'statements'; statements: D1StatementResult[] }
  /** The import-API summary. TRAP: it is NOT shape-distinguishable from a
   * one-statement query result — wrangler wraps it as an array of one entry
   * that also carries a `results` array (`[{ results: [{ "Total queries
   * executed": … }], success, finalBookmark, meta }]`) — so it is detected by
   * its markers, and a caller expecting exactly one statement would otherwise
   * read the summary row as data. Nothing is salvageable from a summary; the
   * caller must re-issue the work through the query API (`--command`). */
  | { kind: 'import-summary'; detail: string }
  /** Parsed as JSON but neither a statement array nor an import summary —
   * e.g. wrangler's `--json` error object `{ "error": … }`. */
  | { kind: 'unrecognized'; detail: string }
  | { kind: 'not-json'; detail: string };

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isStatementResult(value: unknown): value is D1StatementResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as D1StatementResult).results)
  );
}

/** The import path is the only writer of `finalBookmark`, and its single
 * pseudo-result row is the only place the "Total queries executed" column
 * exists. Either marker identifies the summary. */
function isImportSummary(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  if ('finalBookmark' in entry) return true;
  const results = (entry as D1StatementResult).results;
  return (
    Array.isArray(results) &&
    results.some(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        'Total queries executed' in row,
    )
  );
}

const snippet = (value: unknown): string =>
  JSON.stringify(value)?.slice(0, 200) ?? 'undefined';

export function parseD1Output(raw: string): D1ParseOutcome {
  const text = raw.trim();
  let parsed = tryParse(text);
  if (parsed === undefined) {
    // The import path can prefix progress lines before its JSON; retry from
    // the first line that starts a JSON value so the refusal can still be
    // typed as "import summary" rather than a bare parse error.
    const start = text.search(/^[[{]/m);
    if (start !== -1) parsed = tryParse(text.slice(start));
    if (parsed === undefined) {
      return {
        kind: 'not-json',
        detail:
          text === '' ? '(empty output)' : text.split('\n')[0].slice(0, 200),
      };
    }
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some(isImportSummary)) {
    return { kind: 'import-summary', detail: snippet(parsed) };
  }
  if (Array.isArray(parsed) && parsed.every(isStatementResult)) {
    return { kind: 'statements', statements: parsed };
  }
  return { kind: 'unrecognized', detail: snippet(parsed) };
}

/**
 * Splits SQL statements into order-preserving chunks whose joined length stays
 * under `budget`, without ever splitting a statement.
 *
 * Exists because remote execution must go through `--command` (see the parser
 * header), and the whole SQL string rides the process command line — which
 * Windows caps at 32767 characters. A statement larger than the budget still
 * gets a chunk of its own rather than being truncated; the spawn is then the
 * layer that fails, loudly.
 */
export function chunkStatements(
  statements: string[],
  budget: number,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const statement of statements) {
    const addition = statement.length + 2; // joined with ';\n'
    if (current.length > 0 && size + addition > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(statement);
    size += addition;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Runs `fn`, retrying up to `attempts` total tries; a persistent failure
 * rethrows the last error.
 *
 * Exists because wrangler on Node 26/Windows intermittently dies AT EXIT with a
 * libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`) after the query
 * already completed, so subprocess callers see phantom failures. A gate that
 * flakes is not a gate — but a gate that retries forever is not one either, so
 * the bound is small and a persistent failure still fails.
 *
 * `shouldRetry` lets a caller stop early on failures it can prove are
 * deterministic (a wrangler-reported SQL error, say) so only genuinely
 * transient crashes burn attempts.
 */
export function withRetry<T>(
  fn: () => T,
  attempts: number,
  options: {
    onRetry?: (failedAttempt: number, error: unknown) => void;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (options.shouldRetry && !options.shouldRetry(error)) break;
      if (attempt < attempts) options.onRetry?.(attempt, error);
    }
  }
  throw lastError;
}
