/**
 * Refuse `db:migrate:remote` from a checkout that is behind `origin/main`.
 *
 * `wrangler d1 migrations apply` compares the LOCAL `migrations_dir` against
 * the `d1_migrations` table in the remote database. A checkout that predates a
 * merge therefore has nothing new to offer, and wrangler says so — truthfully,
 * and in words that look exactly like success:
 *
 *   ✅ No migrations to apply!
 *
 * That happened on 2026-08-21 with migration `0029`. Workers Builds had already
 * deployed the merged code, so production was running the new application
 * against the old schema while the operator's terminal reported everything was
 * fine. The only tell was the version in npm's own banner (`@0.15.0`, when the
 * merge had minted `0.16.0`), which nothing draws attention to.
 *
 * The failure is silent, indistinguishable from success, and lands on live
 * governance surfaces — so this converts it into a loud refusal. It is
 * deliberately scoped to the REMOTE apply: the same mistake against a local dev
 * database costs nothing and blocking it would only be in the way.
 *
 * SCOPE, stated honestly: this checks that your checkout is not missing commits
 * from `origin/main`. It cannot tell you whether the migration you are about to
 * apply is CORRECT, nor whether the deploy and the migration are ordered the way
 * a not-safe-in-either-order migration needs (see SETUP.md). It closes one
 * specific hole.
 *
 * Usage:
 *
 *   node --experimental-strip-types scripts/check-migrations-current.ts
 *
 * Exits 1 when the checkout is behind, naming the migrations it is missing.
 * Set `MIGRATE_ALLOW_BEHIND=1` to proceed anyway — for a deliberate apply from
 * an older tree, or when the fetch cannot reach the network.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const MIGRATIONS_DIR = 'src/server/db/migrations';
const UPSTREAM = 'origin/main';
const OVERRIDE = 'MIGRATE_ALLOW_BEHIND';

export interface Decision {
  ok: boolean;
  message: string;
}

/**
 * The migration files present upstream but not in this checkout.
 *
 * Compared by FILENAME rather than content: a migration is applied by name and
 * recorded by name in `d1_migrations`, so a file the local tree has never seen
 * is exactly the thing that makes wrangler under-report. Both lists are the
 * `.sql` files under `migrations_dir`; the `meta/` bookkeeping is ignored,
 * since drizzle snapshots are not applied to anything.
 */
export function missingMigrations(
  local: string[],
  upstream: string[],
): string[] {
  const here = new Set(local);
  return upstream.filter((name) => !here.has(name)).sort();
}

/**
 * Whether the apply may proceed, and what to tell the operator.
 *
 * Pure, so the reporting can be tested without a git repository. `behind` is
 * the number of commits reachable from upstream but not from HEAD.
 */
export function decide(input: {
  behind: number;
  missing: string[];
  override: boolean;
  fetched: boolean;
}): Decision {
  if (input.override) {
    return {
      ok: true,
      message:
        `${OVERRIDE} is set — skipping the freshness check.\n` +
        'Applying from a checkout that may be missing migrations.',
    };
  }

  if (input.behind === 0) {
    return {
      ok: true,
      message: input.fetched
        ? `Checkout is level with ${UPSTREAM}.`
        : `Could not reach ${UPSTREAM} to refresh it; the last known state is ` +
          'level with this checkout. Confirm you have pulled before applying.',
    };
  }

  const commits = `${input.behind} commit${input.behind === 1 ? '' : 's'}`;
  const lines = [
    `This checkout is ${commits} behind ${UPSTREAM}.`,
    '',
    'Refusing to apply. `wrangler d1 migrations apply` reads migrations from',
    'your local disk, so applying from here would report "No migrations to',
    'apply!" — which is indistinguishable from success — while leaving the',
    'database behind the code that is already deployed.',
    '',
  ];

  if (input.missing.length > 0) {
    lines.push(
      `${UPSTREAM} has ${input.missing.length} migration(s) this checkout does not:`,
      ...input.missing.map((name) => `  ${name}`),
      '',
    );
  } else {
    lines.push(
      'No migration files are missing, but the checkout is still behind, so',
      'this cannot be confirmed as the tree the deployed code came from.',
      '',
    );
  }

  lines.push(
    'Pull first, then re-run:',
    '',
    '  git checkout main',
    '  git pull',
    '  npm run db:migrate:remote',
    '',
    `Deliberate? Re-run with ${OVERRIDE}=1.`,
  );

  return { ok: false, message: lines.join('\n') };
}

/** `git` output, or null when the command fails for any reason. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function migrationsAt(ref: string | null): string[] {
  const listed =
    ref === null
      ? git(['ls-files', '--', MIGRATIONS_DIR])
      : git(['ls-tree', '-r', '--name-only', ref, '--', MIGRATIONS_DIR]);
  if (listed === null) return [];
  return listed
    .split('\n')
    .filter((line) => line.endsWith('.sql'))
    .map((line) => path.posix.basename(line));
}

function main(): void {
  if (git(['rev-parse', '--git-dir']) === null) {
    console.warn(
      'check-migrations-current: not a git checkout — skipping the freshness check.',
    );
    return;
  }

  // Best effort: an operator applying a migration is online by definition, but
  // a proxy or a credential hiccup should not become an unexplained refusal.
  const fetched = git(['fetch', 'origin', 'main', '--quiet']) !== null;

  const behindRaw = git(['rev-list', '--count', `HEAD..${UPSTREAM}`]);
  if (behindRaw === null) {
    console.warn(
      `check-migrations-current: could not compare against ${UPSTREAM} ` +
        '(no such ref?) — skipping the freshness check.',
    );
    return;
  }

  const decision = decide({
    behind: Number.parseInt(behindRaw, 10),
    missing: missingMigrations(migrationsAt(null), migrationsAt(UPSTREAM)),
    override: process.env[OVERRIDE] === '1',
    fetched,
  });

  if (decision.ok) {
    console.log(`check-migrations-current: ${decision.message}`);
    return;
  }
  console.error(`\ncheck-migrations-current: ${decision.message}\n`);
  process.exit(1);
}

// Import-safe: the pure helpers above are unit-tested, and the IO shell runs
// only when this file is the entry point. `pathToFileURL` rather than a
// `file://` template — on Windows the latter yields `file://C:\...`, which
// never matches `import.meta.url`'s `file:///C:/...`, and the operator this
// script exists for is on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
