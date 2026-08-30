import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPANION_NAME,
  DEFAULT_LOCATOR_REFERENCE,
  DEFAULT_TARGET,
  inspectTarget,
  isRecordEntry,
  mainRepositoryRoot,
  seedRecords,
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
    expect(options.seedRecords).toBe(true);
    expect(options.copyRecords).toBe(false);
    expect(options.recordsFrom).toBeNull();
  });

  it('reads the records source from the environment and the record flags', () => {
    expect(parseArgs([], { ASHEBROOK_RECORDS_SOURCE: '/r' }).recordsFrom).toBe(
      '/r',
    );
    const options = parseArgs(
      ['--records-from', '/x', '--copy', '--no-records'],
      {},
    );
    expect(options.recordsFrom).toBe('/x');
    expect(options.copyRecords).toBe(true);
    expect(options.seedRecords).toBe(false);
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
      recordsFrom: null,
      seedRecords: true,
      copyRecords: false,
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
  it('defaults to the gitignored private/ directory of this checkout', () => {
    expect(DEFAULT_TARGET).toBe('private');
    // path.resolve, not path.join, on both sides: on Windows resolve prepends
    // the CWD's drive letter to a rooted POSIX path and join does not.
    expect(path.resolve('/w/valleys-at-ashebrook-hoa', DEFAULT_TARGET)).toBe(
      path.resolve('/w/valleys-at-ashebrook-hoa', 'private'),
    );
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

describe('records seeding', () => {
  it('classifies record families by name', () => {
    expect(isRecordEntry('HOA_files', true)).toBe(true);
    expect(isRecordEntry('rag_corpus', true)).toBe(true);
    expect(isRecordEntry('operations', true)).toBe(false);
    expect(isRecordEntry('roster-import.sql', false)).toBe(true);
    expect(isRecordEntry('documents-manifest.json', false)).toBe(true);
    expect(isRecordEntry('dedupe-report.json', false)).toBe(true);
    expect(isRecordEntry('README.md', false)).toBe(false);
    expect(isRecordEntry('package.json', false)).toBe(false);
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
    expect(mainRepositoryRoot(tempDir())).not.toBe(main);
  });

  it('hardlinks only the record families and never overwrites', () => {
    const root = tempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    mkdirSync(path.join(source, 'HOA_files', 'sub'), { recursive: true });
    mkdirSync(path.join(source, 'operations'), { recursive: true });
    mkdirSync(target);
    writeFileSync(path.join(source, 'HOA_files', 'sub', 'a.pdf'), 'pdf');
    writeFileSync(path.join(source, 'operations', 'OPERATIONS.md'), 'text');
    writeFileSync(path.join(source, 'roster-import.sql'), 'sql');
    writeFileSync(path.join(source, 'README.md'), 'readme');
    writeFileSync(path.join(target, 'roster-import.sql'), 'mine');

    const result = seedRecords(source, target, false);
    expect(result.families.sort()).toEqual(['HOA_files', 'roster-import.sql']);
    expect(result.linked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(
      readFileSync(path.join(target, 'HOA_files', 'sub', 'a.pdf'), 'utf8'),
    ).toBe('pdf');
    expect(statSync(path.join(target, 'HOA_files', 'sub', 'a.pdf')).ino).toBe(
      statSync(path.join(source, 'HOA_files', 'sub', 'a.pdf')).ino,
    );
    expect(readFileSync(path.join(target, 'roster-import.sql'), 'utf8')).toBe(
      'mine',
    );
    expect(
      statSync(path.join(target, 'operations'), { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(
      statSync(path.join(target, 'README.md'), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });

  it('copies instead of linking when asked, and is a no-op for a missing or same source', () => {
    const root = tempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    mkdirSync(path.join(source, 'rag_corpus'), { recursive: true });
    mkdirSync(target);
    writeFileSync(path.join(source, 'rag_corpus', 'x.md'), 'md');
    const copied = seedRecords(source, target, true);
    expect(copied.linked).toBe(1);
    expect(statSync(path.join(target, 'rag_corpus', 'x.md')).ino).not.toBe(
      statSync(path.join(source, 'rag_corpus', 'x.md')).ino,
    );
    expect(
      seedRecords(path.join(root, 'nope'), target, false).families,
    ).toEqual([]);
  });

  it('reports the main checkout seeding itself as already in place, not as missing records', () => {
    const root = tempDir();
    const source = path.join(root, 'source');
    mkdirSync(path.join(source, 'rag_corpus'), { recursive: true });
    writeFileSync(path.join(source, 'rag_corpus', 'x.md'), 'md');

    const same = seedRecords(source, source, false);
    expect(same.sameRoot).toBe(true);
    expect(same.families).toEqual(['rag_corpus']);
    expect(same.linked).toBe(0);
    expect(same.skipped).toBe(0);
  });

  it('still reports a same-root source holding no families as missing', () => {
    const root = tempDir();
    const empty = path.join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    writeFileSync(path.join(empty, 'README.md'), 'readme');

    const same = seedRecords(empty, empty, false);
    expect(same.sameRoot).toBe(true);
    expect(same.families).toEqual([]);
  });
});
