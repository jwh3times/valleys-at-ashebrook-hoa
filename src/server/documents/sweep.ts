import { isWriteFrozen } from '../authz/write-freeze';

// The R2 orphan sweep (#442). A document file or search twin that no
// documents row points at is unreachable: nothing lists it, downloads it or
// deletes it. The store removes its own leftovers when a write or delete
// fails, but a failure of that cleanup, an interrupted operator import and
// `docs:dedupe`'s missed twins all leave objects behind; this finds them.
//
// It touches two key shapes and nothing else, so a prefix added later (ADR
// 0024's Lot Records) is safe by construction:
//   - `documents/<id>/<name>`, an orphan when no row has that exact r2_key.
//     The upload route and the import scripts sanitize names differently, so
//     the key is never rebuilt from a row's filename.
//   - `rag/<id>.md`, an orphan when no row has that id.

/** Only objects older than this are considered. An upload writes R2 before
 * its row, and an operator import writes its rows only at the end. */
export const SWEEP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Deletions per run; the rest wait for tomorrow's run. */
export const MAX_DELETES_PER_RUN = 100;
/**
 * More orphans than this means something is wrong (a bad migration, a wiped
 * table), not a backlog, so a deleting run deletes nothing and fails.
 * The report-only runs found no orphans, so this is room for ordinary
 * leftovers: well below what a wiped table would report.
 */
export const ORPHAN_THRESHOLD = 50;
/** R2 lists 1,000 keys a page; the library is a few hundred documents. */
export const MAX_LIST_PAGES = 20;

export interface SweepOptions {
  /** The current time; tests move it past the grace. */
  now?: number;
  maxDeletes?: number;
  threshold?: number;
  maxPages?: number;
}

export interface SweepResult {
  /**
   * `frozen`: deletion is on, but the write freeze held it back.
   * `over-threshold`: deletion is on, but more orphans than the sanity
   * threshold were found, so nothing was deleted; the run must fail.
   */
  mode: 'report-only' | 'frozen' | 'over-threshold' | 'deleted';
  /** Document ids (the key's id segment) of orphaned `documents/` files. */
  documents: string[];
  /** Document ids of orphaned `rag/<id>.md` twins. */
  twins: string[];
  deleted: number;
}

const DOCUMENT_KEY = /^documents\/([^/]+)\/.+$/;
const TWIN_KEY = /^rag\/([^/]+)\.md$/;

async function listPrefix(
  env: Env,
  prefix: string,
  maxPages: number,
): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    if (pages === maxPages)
      throw new Error(
        `R2 lists more than ${maxPages} pages under ${prefix}; not sweeping`,
      );
    const page = await env.DOCS.list({ prefix, cursor });
    objects.push(...page.objects);
    if (!page.truncated) return objects;
    cursor = page.cursor;
  }
}

export async function sweepR2Orphans(
  env: Env,
  {
    now = Date.now(),
    maxDeletes = MAX_DELETES_PER_RUN,
    threshold = ORPHAN_THRESHOLD,
    maxPages = MAX_LIST_PAGES,
  }: SweepOptions = {},
): Promise<SweepResult> {
  const cutoff = now - SWEEP_GRACE_MS;
  const old = (o: R2Object) => o.uploaded.getTime() < cutoff;
  const files = (await listPrefix(env, 'documents/', maxPages)).filter(old);
  const twins = (await listPrefix(env, 'rag/', maxPages)).filter(old);

  // The freeze, then the rows, are read after the listing, the slow part, and
  // just before anything is deleted, so a freeze or a row that lands while
  // the bucket is listed is respected. The freeze goes first: an import
  // writes its rows before the operator ends the freeze, so once the freeze
  // reads off, the rows read next include them.
  // Fail-closed: only the literal string turns deletion on.
  const deleting = env.R2_SWEEP_DELETE === 'true';
  const frozen = deleting && (await isWriteFrozen(env));
  const { results: rows } = await env.DATABASE.prepare(
    'SELECT id, r2_key FROM documents',
  ).all<{ id: string; r2_key: string }>();
  const ids = new Set(rows.map((r) => r.id));
  const r2Keys = new Set(rows.map((r) => r.r2_key));

  const orphanFiles = files.filter(
    (o) => DOCUMENT_KEY.test(o.key) && !r2Keys.has(o.key),
  );
  const orphanTwins = twins.filter((o) => {
    const id = TWIN_KEY.exec(o.key)?.[1];
    return id !== undefined && !ids.has(id);
  });
  const report = {
    documents: orphanFiles.map((o) => DOCUMENT_KEY.exec(o.key)![1]),
    twins: orphanTwins.map((o) => TWIN_KEY.exec(o.key)![1]),
  };

  if (!deleting) return { mode: 'report-only', ...report, deleted: 0 };
  if (frozen) return { mode: 'frozen', ...report, deleted: 0 };
  const orphans = [...orphanFiles, ...orphanTwins];
  if (orphans.length > threshold)
    return { mode: 'over-threshold', ...report, deleted: 0 };

  const doomed = orphans.slice(0, maxDeletes).map((o) => o.key);
  if (doomed.length > 0) await env.DOCS.delete(doomed);
  return { mode: 'deleted', ...report, deleted: doomed.length };
}
