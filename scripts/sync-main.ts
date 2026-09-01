/**
 * Bring this checkout AND the private operations companion to the latest
 * default branch, in one command.
 *
 * Work here spans two repositories that are edited in the same sitting: the
 * public tree, and the companion clone under `private/` that carries the
 * runbooks, design history, and handoffs (see `scripts/bootstrap-private.ts`).
 * They are separate Git repositories with separate remotes, so "pull latest"
 * is two sets of commands in two directories — and the companion is the one
 * that gets forgotten, because nothing in a build or a test run reads it, so
 * its staleness is silent.
 *
 * Usage:
 *
 *   npm run sync:main                       # both repositories
 *   npm run sync:main -- --branch release   # a branch other than origin/HEAD
 *   npm run sync:main -- --skip-private     # public tree only
 *   npm run sync:main -- --target ../ops    # companion elsewhere, or ASHEBROOK_OPS_ROOT
 *
 * Per repository: `git fetch --prune origin`, check out the default branch
 * (`origin/HEAD`, falling back to `main`), then `git merge --ff-only
 * origin/<branch>`.
 *
 * What it will NOT do, on purpose:
 *
 * - It refuses a repository with uncommitted changes rather than stashing them
 *   or carrying them across a branch switch. What happens to unfinished work
 *   is the operator's call, not a sync script's.
 * - It fast-forwards only, so a local branch that has diverged from the remote
 *   stops with an error instead of minting a merge commit.
 *
 * A missing companion is reported and skipped rather than failing — a fresh
 * worktree legitimately has none until `npm run bootstrap:private` runs.
 * Anything that actually failed exits 1.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_TARGET, OPS_ROOT_ENV } from './bootstrap-private.ts';

export const FALLBACK_BRANCH = 'main';

export interface Options {
  branch: string | null;
  target: string;
  syncPrivate: boolean;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function parseArgs(
  argv: readonly string[],
  env: EnvLike = process.env,
): Options {
  const options: Options = {
    branch: null,
    target: env[OPS_ROOT_ENV]?.trim() || DEFAULT_TARGET,
    syncPrivate: true,
  };
  const valued = new Set(['--branch', '--target']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-private') {
      options.syncPrivate = false;
      continue;
    }
    if (!valued.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--branch') options.branch = value;
    else options.target = value;
    index += 1;
  }
  return options;
}

/**
 * The branch `origin/HEAD` points at, as a plain branch name.
 *
 * `git symbolic-ref --short refs/remotes/origin/HEAD` prints `origin/main`.
 * Anything else — an unset `origin/HEAD`, an error on stderr — falls back to
 * `main` rather than guessing; a repository whose default branch is neither is
 * still handled by naming it with `--branch`.
 */
export function defaultBranchFrom(symbolicRef: string): string {
  const value = symbolicRef.trim();
  const prefix = 'origin/';
  if (!value.startsWith(prefix)) return FALLBACK_BRANCH;
  return value.slice(prefix.length) || FALLBACK_BRANCH;
}

/** `git status --porcelain` prints nothing at all for a clean tree. */
export function isDirty(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}

export type SyncStatus = 'updated' | 'current' | 'skipped' | 'failed';

export interface SyncResult {
  label: string;
  status: SyncStatus;
  detail: string;
}

const MARKS: Record<SyncStatus, string> = {
  updated: '+',
  current: '=',
  skipped: '-',
  failed: 'x',
};

export function describeResult(result: SyncResult): string {
  return `${MARKS[result.status]} ${result.label}: ${result.detail}`;
}

export interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (root: string, args: readonly string[]) => GitRun;

export const runGit: GitRunner = (root, args) => {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/** The first non-empty line of git's complaint, for a one-line report. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ?? 'no output';
}

/**
 * Fetch, check out the branch, and fast-forward one repository.
 *
 * The git runner is injected so the sequencing can be exercised against real
 * repositories in a temporary directory, and so a test can assert the refusals
 * without a network remote.
 */
export function syncRepository(
  root: string,
  label: string,
  requestedBranch: string | null,
  git: GitRunner = runGit,
): SyncResult {
  const fail = (detail: string): SyncResult => ({
    label,
    status: 'failed',
    detail,
  });

  if (!existsSync(path.join(root, '.git'))) {
    return { label, status: 'skipped', detail: `no Git repository at ${root}` };
  }

  const status = git(root, ['status', '--porcelain']);
  if (status.status !== 0) return fail(firstLine(status.stderr));
  if (isDirty(status.stdout)) {
    return fail(
      'uncommitted changes; commit or stash them, then run this again',
    );
  }

  const fetch = git(root, ['fetch', '--prune', 'origin']);
  if (fetch.status !== 0) return fail(firstLine(fetch.stderr));

  const branch =
    requestedBranch ??
    defaultBranchFrom(
      git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout,
    );

  const previousBranch = git(root, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]).stdout.trim();
  const before = git(root, ['rev-parse', 'HEAD']).stdout.trim();

  if (previousBranch !== branch) {
    const checkout = git(root, ['checkout', branch]);
    if (checkout.status !== 0) return fail(firstLine(checkout.stderr));
  }

  const merge = git(root, ['merge', '--ff-only', `origin/${branch}`]);
  if (merge.status !== 0) return fail(firstLine(merge.stderr));

  const after = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const switched =
    previousBranch === branch ? '' : ` (was on ${previousBranch})`;
  if (before === after) {
    return {
      label,
      status: 'current',
      detail: `${branch} already up to date at ${after.slice(0, 7)}${switched}`,
    };
  }
  const count = git(root, [
    'rev-list',
    '--count',
    `${before}..${after}`,
  ]).stdout.trim();
  const commits = count && count !== '0' ? `, ${count} new commit(s)` : '';
  return {
    label,
    status: 'updated',
    detail: `${branch} now at ${after.slice(0, 7)}${commits}${switched}`,
  };
}

export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const worktreeRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );

  const results: SyncResult[] = [
    syncRepository(worktreeRoot, 'valleys-at-ashebrook-hoa', options.branch),
  ];

  if (options.syncPrivate) {
    const companionRoot = path.resolve(worktreeRoot, options.target);
    if (existsSync(path.join(companionRoot, '.git'))) {
      results.push(syncRepository(companionRoot, 'private companion', null));
    } else {
      results.push({
        label: 'private companion',
        status: 'skipped',
        detail: `not installed at ${companionRoot}; run \`npm run bootstrap:private\``,
      });
    }
  }

  for (const result of results) console.log(describeResult(result));
  return results.some((result) => result.status === 'failed') ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
