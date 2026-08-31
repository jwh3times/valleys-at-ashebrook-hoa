/**
 * Guard the migrations directory, which is what actually decides what runs.
 *
 * `wrangler d1 migrations apply` reads the DIRECTORY — every `.sql` file under
 * `migrations_dir`, in filename order — and records what it applied in the
 * `d1_migrations` table. It does not consult Drizzle's `meta/_journal.json`.
 * That was measured on 2026-08-21: a `.sql` file with no journal entry is
 * listed as pending and applied all the same, contradicting the note left on
 * #248 ("hand-add the `meta/_journal.json` entry, or `db:migrate:local` will
 * not see the file").
 *
 * The consequence is the opposite of what that note assumed. A forgotten
 * journal entry is harmless; a STRAY `.sql` file is a production migration
 * nobody wrote on purpose. So this checks the directory rather than the
 * journal:
 *
 *  - every file is named `NNNN_snake_case.sql`, so ordering is total and
 *    unambiguous;
 *  - indices are unique — two branches that both add `0030` would otherwise
 *    merge cleanly and apply in filename order, which is not the order either
 *    author tested;
 *  - indices are contiguous from `0000`, so a deleted or renamed migration is
 *    caught rather than silently changing what a fresh database receives;
 *  - `_journal.json`, which this project keeps but no longer generates, lists
 *    exactly the files on disk — it is allowed to be vestigial, not to lie.
 *
 * Drizzle SNAPSHOTS (`meta/*_snapshot.json`) are deliberately NOT checked. The
 * chain has been abandoned since `0019` and is five migrations stale (#257):
 * migrations here are hand-authored, `db:generate` is not part of the workflow,
 * and requiring a snapshot per migration would enforce a workflow this project
 * does not use. See docs/agents/migrations.md.
 *
 * Usage:
 *
 *   node --experimental-strip-types scripts/check-migration-files.ts
 *
 * Exits 1 listing every problem.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const MIGRATIONS_DIR = path.join(
  REPO_ROOT,
  'src',
  'server',
  'db',
  'migrations',
);
const JOURNAL = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
const FILENAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export interface JournalEntry {
  idx: number;
  tag: string;
}

/**
 * Every problem with the migration set, as operator-readable lines.
 *
 * Pure, so the rules are testable without a migrations directory. `files` is
 * the `.sql` basenames on disk; `journal` is `_journal.json`'s entries.
 */
export function migrationProblems(
  files: string[],
  journal: JournalEntry[],
): string[] {
  const problems: string[] = [];

  const malformed = files.filter((name) => !FILENAME.test(name)).sort();
  for (const name of malformed) {
    problems.push(
      `${name}: not named NNNN_snake_case.sql — wrangler applies this ` +
        'directory in filename order, so an unparseable name has no defined ' +
        'position',
    );
  }

  const wellFormed = files.filter((name) => FILENAME.test(name)).sort();
  const byIndex = new Map<number, string[]>();
  for (const name of wellFormed) {
    const idx = Number.parseInt(name.slice(0, 4), 10);
    byIndex.set(idx, [...(byIndex.get(idx) ?? []), name]);
  }

  for (const [idx, names] of [...byIndex].sort((a, b) => a[0] - b[0])) {
    if (names.length > 1)
      problems.push(
        `duplicate index ${String(idx).padStart(4, '0')}: ${names.join(', ')} ` +
          '— two migrations claiming one position apply in filename order, ' +
          'which is not the order either was written against',
      );
  }

  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  for (let expected = 0; expected < indices.length; expected += 1) {
    if (indices[expected] !== expected) {
      problems.push(
        `gap before ${String(indices[expected]).padStart(4, '0')}: expected ` +
          `${String(expected).padStart(4, '0')} — a missing index means a ` +
          'migration was deleted or renamed, changing what a fresh database ' +
          'receives',
      );
      break;
    }
  }

  // The journal no longer drives anything (wrangler reads the directory), but
  // a stale one misleads the next person to open it.
  const onDisk = new Set(wellFormed.map((name) => name.replace(/\.sql$/, '')));
  const listed = new Set(journal.map((entry) => entry.tag));
  for (const tag of [...onDisk].filter((t) => !listed.has(t)).sort())
    problems.push(
      `${tag}.sql is on disk but missing from meta/_journal.json — it WILL ` +
        'apply (wrangler reads the directory); add the entry so the journal ' +
        'does not disagree with reality',
    );
  for (const tag of [...listed].filter((t) => !onDisk.has(t)).sort())
    problems.push(
      `meta/_journal.json lists ${tag}, which has no .sql file on disk`,
    );

  return problems;
}

function main(): void {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'));
  const journal = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) as {
    entries: JournalEntry[];
  };

  const problems = migrationProblems(files, journal.entries);
  if (problems.length === 0) {
    console.log(
      `check-migration-files: ${files.length} migrations, contiguous and ` +
        'consistent with the journal.',
    );
    return;
  }

  console.error(
    `check-migration-files: found ${problems.length} problem(s).\n` +
      '`wrangler d1 migrations apply` applies every .sql file in this ' +
      'directory, in filename order — a stray or mis-numbered file is a ' +
      'production migration.\n',
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
