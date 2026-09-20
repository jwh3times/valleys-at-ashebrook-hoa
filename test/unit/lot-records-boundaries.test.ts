import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOT_RECORD_ACTIONS,
  LOT_RECORD_REASON_CODES,
  LOT_RECORD_TYPES,
  LOT_VIOLATION_CATEGORIES,
  LOT_VIOLATION_STATUSES,
} from '../../src/lib/types';

/**
 * The static half of ADR 0024's guarantees (#291).
 *
 * Three of them cannot be proved by running a query, because what they forbid
 * is code that does not exist yet:
 *
 * 1. **The AI assistant and the document pipeline never ingest a Lot Record.**
 *    Lot Records are not documents. They never enter `documents`, never reach
 *    R2 under `documents/` or `rag/`, and so never reach the AI Search index,
 *    which is scoped to `rag/` and is NOT tier-aware (SECURITY.md). A single
 *    read of a Lot Record table from `src/server/ai/` would put one Lot's
 *    enforcement history into an index every homeowner can query.
 * 2. **`lot_record_events` is append-only**, by convention rather than by a
 *    trigger, the same discipline ADR 0022's ledger and `setting_changes`
 *    follow.
 * 3. **The vocabulary in `src/lib/types.ts` and the CHECK constraints in the
 *    migration agree.** SQL cannot import TypeScript, so the two lists are
 *    written twice and pinned here; a category added to one and not the other
 *    would fail at runtime as a constraint violation, on the board's first
 *    attempt to use it.
 */

const SRC = join(process.cwd(), 'src');
/** Table names and their Drizzle identifiers, for the scans below. */
const LOT_RECORD_TABLES: Record<string, string> = {
  lot_violations: 'lotViolations',
  dues_ledger_entries: 'duesLedgerEntries',
  lot_record_events: 'lotRecordEvents',
};

/**
 * The tables ADR 0025 and ADR 0024 both declare append-only. Nothing may
 * UPDATE or DELETE a row in any of them: a mistaken ledger entry is corrected
 * by a reversal, and a mistaken violation by a void.
 */
const APPEND_ONLY_TABLES: Record<string, string> = {
  lot_record_events: 'lotRecordEvents',
  dues_ledger_entries: 'duesLedgerEntries',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

const relative = (file: string) =>
  file
    .slice(SRC.length + 1)
    .split('\\')
    .join('/');

describe('the AI surfaces never touch a Lot Record', () => {
  /**
   * Every module that can put text into the AI Search index or into a
   * generated answer: the assistant and its retrieval, the report generator,
   * and the pseudonymizer's dictionary loader (all under `server/ai`), plus the
   * two admin routes that actually write R2 objects under `documents/` and
   * `rag/`. The index is scoped to `rag/` and is NOT tier-aware (SECURITY.md),
   * so one Lot's enforcement history reaching it would be readable by every
   * homeowner who can ask the assistant a question.
   *
   * Paths are asserted to exist rather than skipped when missing: a scan that
   * silently reads nothing after a rename is worse than no scan, because it
   * still reports green.
   */
  const AI_PATHS = [
    'server/ai',
    'pages/api/admin/documents.ts',
    'pages/api/admin/duplicates.ts',
    'pages/api/admin/assistant.ts',
    'pages/api/admin/reports.ts',
  ];

  /** Every source file at one path, whether it names a directory or a file. */
  function filesAt(path: string): string[] {
    const full = join(SRC, ...path.split('/'));
    return statSync(full).isDirectory() ? sourceFiles(full) : [full];
  }

  it('resolves every scanned path, so a rename fails loudly instead of quietly', () => {
    for (const path of AI_PATHS)
      expect(filesAt(path).length).toBeGreaterThan(0);
  });

  it('has no reference to a Lot Record table from any of them', () => {
    const offenders: string[] = [];
    for (const path of AI_PATHS)
      for (const file of filesAt(path)) {
        const text = readFileSync(file, 'utf8');
        for (const [table, identifier] of Object.entries(LOT_RECORD_TABLES)) {
          if (text.includes(table))
            offenders.push(`${relative(file)}: names ${table}`);
          // Concatenated, NOT a template literal. This is the dangerous half
          // of that rule: inside a template literal `\b` is not an invalid
          // escape, it is the BACKSPACE character — so the pattern became
          // <BS>identifier<BS>, matched nothing, and NO lint rule objects.
          // This check was vacuous from the day it was written (#291 slice 1)
          // until a planted reference in src/server/ai/pii.ts exposed it; the
          // table-name half above, a plain `includes`, is what was actually
          // holding the line.
          if (new RegExp('\\b' + identifier + '\\b').test(text))
            offenders.push(`${relative(file)}: imports ${identifier}`);
        }
        if (text.includes('lot-records'))
          offenders.push(`${relative(file)}: imports the lot-records module`);
      }
    expect(offenders).toEqual([]);
  });

  it('names every Lot Record type in the scanned table list, so the scan cannot go stale', () => {
    // A record type added to LOT_RECORD_TYPES without an entry above would be
    // scanned for by nobody. This is the link between the two lists.
    for (const type of LOT_RECORD_TYPES)
      expect(Object.keys(LOT_RECORD_TABLES)).toContain(type);
  });
});

describe('the append-only tables really are', () => {
  it('has no UPDATE or DELETE against any of them in src/, raw or Drizzle', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(file);
      // Patterns are built by CONCATENATION with doubled backslashes, never
      // inside a plain template literal. In one, `\s` is an invalid escape
      // that silently becomes the letter `s`, so the pattern compiles to
      // `UPDATEs+…` and matches nothing while the suite reports green. This
      // guard shipped that way once; oxlint's no-useless-escape caught it,
      // which is luck rather than coverage. (`String.raw` would also be
      // correct and is used elsewhere in test/unit — concatenation is used
      // here so the escaping is visible at the point of use.)
      const bare = text.replace(/["`]/g, '');
      for (const [table, identifier] of Object.entries(APPEND_ONLY_TABLES)) {
        if (new RegExp('UPDATE\\s+' + table, 'i').test(bare))
          offenders.push(`${rel}: raw UPDATE against ${table}`);
        if (new RegExp('DELETE\\s+FROM\\s+' + table, 'i').test(bare))
          offenders.push(`${rel}: raw DELETE against ${table}`);
        if (new RegExp('\\.update\\(\\s*' + identifier + '\\s*\\)').test(text))
          offenders.push(`${rel}: Drizzle .update(${identifier})`);
        if (new RegExp('\\.delete\\(\\s*' + identifier + '\\s*\\)').test(text))
          offenders.push(`${rel}: Drizzle .delete(${identifier})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the Lot Record vocabulary matches the database', () => {
  /**
   * SQL cannot import TypeScript, so each of these lists is written twice —
   * once in `src/lib/types.ts` and once as a CHECK — and a drift between them
   * is a runtime constraint violation on the board's first use of the new
   * value, not a type error.
   *
   * The CHECK to compare against is the one in the migration that most
   * recently DEFINED it. `0035` rebuilt `lot_record_events` to bound
   * `reason_code`, so `0034`'s copy of that table no longer describes the live
   * shape; reading the wrong file is how this suite would keep passing while
   * checking a table that no longer exists. `definingMigration` finds the last
   * file that mentions each constraint rather than trusting a hard-coded path,
   * so the next rebuild moves the target automatically.
   */
  const MIGRATIONS = join(SRC, 'server', 'db', 'migrations');

  const migrationFiles = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  function definingMigration(constraint: string): string {
    const defining = migrationFiles.filter((f) =>
      readFileSync(join(MIGRATIONS, f), 'utf8').includes(
        `CONSTRAINT "${constraint}"`,
      ),
    );
    if (defining.length === 0)
      throw new Error(`no migration defines ${constraint}`);
    return readFileSync(join(MIGRATIONS, defining.at(-1)!), 'utf8');
  }

  /**
   * The quoted values of one CHECK's `IN (...)` list.
   *
   * Parsed by slicing rather than by a regular expression: the CHECK bodies
   * differ in shape (`reason_code`'s is `IS NULL OR ... IN (...)`), and a
   * pattern loose enough for both is a pattern that quietly matches the wrong
   * thing.
   */
  function checkValues(constraint: string): string[] {
    const sql = definingMigration(constraint);
    const at = sql.indexOf(`CONSTRAINT "${constraint}"`);
    const open = sql.indexOf('IN (', at);
    const close = sql.indexOf(')', open);
    if (at < 0 || open < 0 || close < 0)
      throw new Error(`no IN list on ${constraint}`);
    return sql
      .slice(open + 'IN ('.length, close)
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''));
  }

  it('bounds lot_violations.category to LOT_VIOLATION_CATEGORIES', () => {
    expect(checkValues('lot_violations_category_check')).toEqual([
      ...LOT_VIOLATION_CATEGORIES,
    ]);
  });

  it('bounds lot_violations.status to LOT_VIOLATION_STATUSES', () => {
    expect(checkValues('lot_violations_status_check')).toEqual([
      ...LOT_VIOLATION_STATUSES,
    ]);
  });

  it('bounds lot_record_events.record_type to LOT_RECORD_TYPES', () => {
    expect(checkValues('lot_record_events_record_type_check')).toEqual([
      ...LOT_RECORD_TYPES,
    ]);
  });

  it('bounds lot_record_events.action to LOT_RECORD_ACTIONS', () => {
    expect(checkValues('lot_record_events_action_check')).toEqual([
      ...LOT_RECORD_ACTIONS,
    ]);
  });

  it('bounds lot_record_events.reason_code to LOT_RECORD_REASON_CODES', () => {
    expect(checkValues('lot_record_events_reason_code_check')).toEqual([
      ...LOT_RECORD_REASON_CODES,
    ]);
  });

  it('reads the rebuild rather than the original table definition', () => {
    // The guard on the guard: if a later migration rebuilds these tables
    // again, this is the assertion that notices the target moved.
    expect(definingMigration('lot_record_events_reason_code_check')).toContain(
      '__new_lot_record_events',
    );
    expect(definingMigration('lot_violations_category_check')).toContain(
      'CREATE TABLE `lot_violations`',
    );
  });
});
