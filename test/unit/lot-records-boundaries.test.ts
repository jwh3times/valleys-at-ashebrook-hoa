import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOT_RECORD_ACTIONS,
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
const MIGRATION = join(
  SRC,
  'server',
  'db',
  'migrations',
  '0034_lot_records.sql',
);

/** Table names and their Drizzle identifiers, for the scans below. */
const LOT_RECORD_TABLES: Record<string, string> = {
  lot_violations: 'lotViolations',
  lot_record_events: 'lotRecordEvents',
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
          if (new RegExp(`\b${identifier}\b`).test(text))
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

describe('lot_record_events is append-only', () => {
  it('has no UPDATE or DELETE against the table anywhere in src/, raw or Drizzle', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(file);
      if (/UPDATE\s+["`]?lot_record_events["`]?/i.test(text))
        offenders.push(`${rel}: raw UPDATE against lot_record_events`);
      if (/DELETE\s+FROM\s+["`]?lot_record_events["`]?/i.test(text))
        offenders.push(`${rel}: raw DELETE against lot_record_events`);
      if (/\.update\(\s*lotRecordEvents\s*\)/.test(text))
        offenders.push(`${rel}: Drizzle .update(lotRecordEvents)`);
      if (/\.delete\(\s*lotRecordEvents\s*\)/.test(text))
        offenders.push(`${rel}: Drizzle .delete(lotRecordEvents)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the Lot Record vocabulary matches the database', () => {
  const migration = readFileSync(MIGRATION, 'utf8');

  /** The quoted values of one `IN (...)` list in the migration. */
  function checkValues(constraint: string): string[] {
    const match = new RegExp(
      `CONSTRAINT "${constraint}" CHECK\\("[a-z_]+" IN \\(([^)]*)\\)\\)`,
    ).exec(migration);
    if (!match) throw new Error(`no CHECK named ${constraint} in ${MIGRATION}`);
    return match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
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
});
