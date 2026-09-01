import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TARGET } from '../../scripts/bootstrap-private';
import {
  defaultBranchFrom,
  describeResult,
  FALLBACK_BRANCH,
  isDirty,
  parseArgs,
  syncRepository,
} from '../../scripts/sync-main';

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
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** A bare `origin` with one commit on `main`, plus a clone of it. */
function repoPair(): { origin: string; clone: string } {
  const base = tempDir();
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const clone = path.join(base, 'clone');
  git(base, 'init', '--bare', '--initial-branch=main', origin);
  git(base, 'clone', origin, seed);
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  writeFileSync(path.join(seed, 'README.md'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'one');
  git(seed, 'push', 'origin', 'main');
  git(base, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Test');
  return { origin, clone };
}

function pushCommit(origin: string, message: string): void {
  const work = path.join(tempDir(), 'work');
  git(path.dirname(work), 'clone', origin, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  writeFileSync(path.join(work, `${message}.txt`), `${message}\n`);
  git(work, 'add', '.');
  git(work, 'commit', '-m', message);
  git(work, 'push', 'origin', 'main');
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

describe('syncRepository', () => {
  it('skips a directory that is not a Git repository', () => {
    const result = syncRepository(tempDir(), 'companion', null);
    expect(result.status).toBe('skipped');
    expect(result.detail).toMatch(/no Git repository/u);
  });

  it('fast-forwards the default branch and reports the new commits', () => {
    const { origin, clone } = repoPair();
    pushCommit(origin, 'two');

    const result = syncRepository(clone, 'clone', null);
    expect(result.status).toBe('updated');
    expect(result.detail).toContain('main now at');
    expect(result.detail).toContain('1 new commit(s)');
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('switches back to the default branch before pulling', () => {
    const { origin, clone } = repoPair();
    git(clone, 'checkout', '-b', 'feature/thing');
    pushCommit(origin, 'three');

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
    const { origin, clone } = repoPair();
    git(clone, 'checkout', '-b', 'feature/thing');
    writeFileSync(path.join(clone, 'README.md'), 'edited\n');
    pushCommit(origin, 'four');

    const result = syncRepository(clone, 'clone', null);
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/uncommitted changes/u);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'feature/thing',
    );
  });

  it('fails rather than merging a branch that has diverged from the remote', () => {
    const { origin, clone } = repoPair();
    writeFileSync(path.join(clone, 'local.txt'), 'local\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'local only');
    pushCommit(origin, 'five');

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
