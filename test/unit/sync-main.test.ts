// @vitest-environment node
// Nothing here touches the DOM — these cases drive real `git` subprocesses —
// and jsdom costs about a second of environment setup per file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TARGET } from '../../scripts/bootstrap-private';
import {
  defaultBranchFrom,
  describeResult,
  FALLBACK_BRANCH,
  isDirty,
  parseArgs,
  syncRepository,
} from '../../scripts/sync-main';

/**
 * How long the real-git cases get (#336).
 *
 * The rest of this suite is pure JS and finishes in single-digit milliseconds,
 * but each `syncRepository` case below drives a dozen-odd real `git`
 * subprocesses. Process spawn on Windows is far slower than on CI's Linux
 * runners, and `npm test` runs 90-plus files in parallel, so the global 5s
 * default left roughly a 2x margin and lost the race routinely — a varying set
 * of these cases failed on most local full runs while CI stayed green, which is
 * a false red that trains people to ignore local failures. Deliberately
 * generous: sized never to fire for a merely slow machine, only for a hang.
 */
const REAL_GIT_TIMEOUT_MS = 30_000;

/**
 * Every `git` call is made with the developer's own configuration switched off.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at an empty file mean a
 * machine that sets `commit.gpgsign`, `core.autocrlf`, `init.defaultBranch`, or
 * a hooks path cannot change what these tests exercise — Git for Windows sets
 * several of those in system config out of the box. An empty file rather than
 * `os.devNull`: that is `\\.\nul` on Windows, which Git's MSYS layer rejects
 * outright (`fatal: unable to access '//./nul'`). The identity travels in the
 * environment rather than a `git config` call per repository, which is two
 * fewer subprocesses each time one is built.
 */
const configHome = mkdtempSync(path.join(os.tmpdir(), 'sync-main-cfg-'));
const emptyGitConfig = path.join(configHome, 'gitconfig');
writeFileSync(emptyGitConfig, '');
afterAll(() => rmSync(configHome, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_SYSTEM: emptyGitConfig,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-main-'));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  // stderr is piped rather than inherited so git's progress chatter ("Cloning
  // into…") stays out of the test reporter; execFileSync still attaches it to
  // the thrown error when a command actually fails.
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * A bare `origin` with one commit on `main`, the `clone` under test, and the
 * `seed` clone that made that commit.
 *
 * `seed` is returned rather than thrown away so `pushCommit` can reuse it:
 * adding a commit to `origin` then costs three subprocesses instead of cloning
 * the whole repository afresh for six.
 */
function repoPair(): { origin: string; clone: string; seed: string } {
  const base = tempDir();
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const clone = path.join(base, 'clone');
  git(base, 'init', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', origin, seed);
  writeFileSync(path.join(seed, 'README.md'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'one');
  git(seed, 'push', 'origin', 'main');
  git(base, 'clone', origin, clone);
  return { origin, clone, seed };
}

/** Add one commit to `origin`, through the seed clone that already exists. */
function pushCommit(seed: string, message: string): void {
  writeFileSync(path.join(seed, `${message}.txt`), `${message}\n`);
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', message);
  git(seed, 'push', 'origin', 'main');
}

describe('parseArgs', () => {
  it('defaults to both repositories and the private/ companion', () => {
    const options = parseArgs([], {});
    expect(options.branch).toBeNull();
    expect(options.target).toBe(DEFAULT_TARGET);
    expect(options.syncPrivate).toBe(true);
  });

  it('reads the companion root from the environment', () => {
    expect(parseArgs([], { ASHEBROOK_OPS_ROOT: ' ../ops ' }).target).toBe(
      '../ops',
    );
  });

  it('accepts every flag and lets flags override the environment', () => {
    const options = parseArgs(
      ['--branch', 'release', '--target', '/elsewhere', '--skip-private'],
      { ASHEBROOK_OPS_ROOT: '/ignored' },
    );
    expect(options.branch).toBe('release');
    expect(options.target).toBe('/elsewhere');
    expect(options.syncPrivate).toBe(false);
  });

  it('rejects an unknown argument and a flag with no value', () => {
    expect(() => parseArgs(['--pull'], {})).toThrow(/Unknown argument/u);
    expect(() => parseArgs(['--branch'], {})).toThrow(/requires a value/u);
  });
});

describe('defaultBranchFrom', () => {
  it('reads the branch name out of origin/HEAD', () => {
    expect(defaultBranchFrom('origin/main\n')).toBe('main');
    expect(defaultBranchFrom('origin/trunk')).toBe('trunk');
  });

  it('falls back when origin/HEAD is unset or unrecognized', () => {
    expect(defaultBranchFrom('')).toBe(FALLBACK_BRANCH);
    expect(defaultBranchFrom('fatal: ref refs/remotes/origin/HEAD')).toBe(
      FALLBACK_BRANCH,
    );
    expect(defaultBranchFrom('origin/')).toBe(FALLBACK_BRANCH);
  });
});

describe('isDirty', () => {
  it('treats only non-empty porcelain output as dirty', () => {
    expect(isDirty('')).toBe(false);
    expect(isDirty('\n')).toBe(false);
    expect(isDirty(' M src/pages/index.astro\n')).toBe(true);
  });
});

describe('describeResult', () => {
  it('prefixes each repository line with its outcome', () => {
    expect(
      describeResult({
        label: 'ops',
        status: 'updated',
        detail: 'main at abc',
      }),
    ).toBe('+ ops: main at abc');
    expect(
      describeResult({ label: 'ops', status: 'failed', detail: 'nope' }),
    ).toBe('x ops: nope');
  });
});

// The timeout is set on the block rather than the file so the pure-JS suites
// above keep the strict global default; only the cases that spawn real `git`
// get the longer budget.
describe('syncRepository', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('skips a directory that is not a Git repository', () => {
    const result = syncRepository(tempDir(), 'companion', null);
    expect(result.status).toBe('skipped');
    expect(result.detail).toMatch(/no Git repository/u);
  });

  it('fast-forwards the default branch and reports the new commits', () => {
    const { clone, seed } = repoPair();
    pushCommit(seed, 'two');

    const result = syncRepository(clone, 'clone', null);
    expect(result.status).toBe('updated');
    expect(result.detail).toContain('main now at');
    expect(result.detail).toContain('1 new commit(s)');
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('switches back to the default branch before pulling', () => {
    const { clone, seed } = repoPair();
    git(clone, 'checkout', '-b', 'feature/thing');
    pushCommit(seed, 'three');

    const result = syncRepository(clone, 'clone', null);
    expect(result.status).toBe('updated');
    expect(result.detail).toContain('was on feature/thing');
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('reports an already-current repository without claiming an update', () => {
    const { clone } = repoPair();
    const result = syncRepository(clone, 'clone', null);
    expect(result.status).toBe('current');
    expect(result.detail).toContain('already up to date');
  });

  it('refuses a repository with uncommitted changes and leaves it alone', () => {
    const { clone, seed } = repoPair();
    git(clone, 'checkout', '-b', 'feature/thing');
    writeFileSync(path.join(clone, 'README.md'), 'edited\n');
    pushCommit(seed, 'four');

    const result = syncRepository(clone, 'clone', null);
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/uncommitted changes/u);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'feature/thing',
    );
  });

  it('fails rather than merging a branch that has diverged from the remote', () => {
    const { clone, seed } = repoPair();
    writeFileSync(path.join(clone, 'local.txt'), 'local\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'local only');
    pushCommit(seed, 'five');

    const result = syncRepository(clone, 'clone', null);
    expect(result.status).toBe('failed');
    expect(git(clone, 'log', '--oneline', '-1')).toContain('local only');
  });

  it('honours an explicitly requested branch', () => {
    const { origin, clone } = repoPair();
    const result = syncRepository(clone, 'clone', 'main', (root, args) => {
      expect(args).not.toContain('symbolic-ref');
      return {
        status: 0,
        stdout: execFileSync('git', [...args], { cwd: root, encoding: 'utf8' }),
        stderr: '',
      };
    });
    expect(result.status).toBe('current');
    expect(origin).toBeTruthy();
  });
});
