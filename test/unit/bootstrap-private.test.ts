import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPANION_NAME,
  DEFAULT_LOCATOR_REFERENCE,
  defaultCompanionRoot,
  inspectTarget,
  mainRepositoryRoot,
  parseArgs,
  validateCloneUrl,
} from '../../scripts/bootstrap-private';

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bootstrap-private-'));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults to the Workstation Bootstrap locator reference', () => {
    const options = parseArgs([], {});
    expect(options.reference).toBe(DEFAULT_LOCATOR_REFERENCE);
    expect(options.url).toBeNull();
    expect(options.target).toBeNull();
    expect(options.materialize).toBe(false);
  });

  it('reads the service-account reference and ops root from the environment', () => {
    const options = parseArgs([], {
      ASHEBROOK_OP_SERVICE_ACCOUNT_REFERENCE: 'op://dev/token/credential',
      ASHEBROOK_OPS_ROOT: ' /elsewhere/ops ',
    });
    expect(options.serviceAccountReference).toBe('op://dev/token/credential');
    expect(options.target).toBe('/elsewhere/ops');
  });

  it('accepts every flag and lets flags override the environment', () => {
    const options = parseArgs(
      [
        '--url',
        'git@github.com:o/r.git',
        '--op-reference',
        'op://v/i/f',
        '--service-account-reference',
        'op://v/t/c',
        '--target',
        '/t',
        '--materialize',
        '--force',
      ],
      { ASHEBROOK_OPS_ROOT: '/ignored' },
    );
    expect(options).toEqual({
      url: 'git@github.com:o/r.git',
      reference: 'op://v/i/f',
      serviceAccountReference: 'op://v/t/c',
      target: '/t',
      materialize: true,
      force: true,
    });
  });

  it('rejects unknown and valueless arguments', () => {
    expect(() => parseArgs(['--nope'], {})).toThrow('Unknown argument: --nope');
    expect(() => parseArgs(['--url'], {})).toThrow('--url requires a value.');
  });
});

describe('validateCloneUrl', () => {
  it('accepts credential-free GitHub HTTPS and SSH locators', () => {
    expect(validateCloneUrl(`https://github.com/o/${COMPANION_NAME}.git`)).toBe(
      `https://github.com/o/${COMPANION_NAME}.git`,
    );
    expect(validateCloneUrl('git@github.com:o/r')).toBe('git@github.com:o/r');
  });

  it('refuses embedded credentials, other hosts, and multi-line values', () => {
    expect(() => validateCloneUrl('https://x:y@github.com/o/r.git')).toThrow(
      'embedded credential',
    );
    expect(() => validateCloneUrl('https://gitlab.com/o/r.git')).toThrow(
      'github.com',
    );
    expect(() => validateCloneUrl('git@example.com:o/r.git')).toThrow(
      'credential-free GitHub',
    );
    expect(() => validateCloneUrl('https://github.com/o/r.git\nextra')).toThrow(
      'single line',
    );
  });
});

describe('companion location', () => {
  it('is a sibling of the main root named after the companion', () => {
    expect(defaultCompanionRoot('/w/valleys-at-ashebrook-hoa')).toBe(
      path.join('/w', COMPANION_NAME),
    );
  });

  it('resolves a linked worktree back to its main checkout', () => {
    const root = tempDir();
    const main = path.join(root, 'main');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(
      main,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    const worktree = path.join(root, 'wt');
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'wt');

    expect(mainRepositoryRoot(main)).toBe(main);
    expect(mainRepositoryRoot(worktree)).toBe(main);
    expect(defaultCompanionRoot(mainRepositoryRoot(worktree))).toBe(
      path.join(root, COMPANION_NAME),
    );
  });

  it('falls back to the given root outside any repository', () => {
    const root = tempDir();
    expect(mainRepositoryRoot(root)).toBe(root);
  });
});

describe('inspectTarget', () => {
  it('distinguishes absent, installed, and occupied targets', () => {
    const root = tempDir();
    expect(inspectTarget(path.join(root, 'missing'))).toBe('absent');
    const empty = path.join(root, 'empty');
    mkdirSync(empty);
    expect(inspectTarget(empty)).toBe('absent');
    const occupied = path.join(root, 'occupied');
    mkdirSync(occupied);
    writeFileSync(path.join(occupied, 'note.md'), 'x');
    expect(inspectTarget(occupied)).toBe('occupied');
    const installed = path.join(root, 'installed');
    mkdirSync(path.join(installed, '.git'), { recursive: true });
    expect(inspectTarget(installed)).toBe('installed');
  });
});
