/**
 * Install the private operations companion into this checkout's private/ directory, and
 * optionally materialize `.env`/`.dev.vars` from 1Password through it.
 *
 * The private companion (a separate private GitHub repository) holds the
 * operational runbooks, design history, and the 1Password secret-reference
 * templates the public tree must never carry. Its locator is deliberately NOT
 * committed here: it is read at run time from the Ashebrook vault's
 * `Workstation Bootstrap` item through the 1Password CLI, so this file names
 * only an `op://` reference, never a URL.
 *
 * Where it goes: `private/` under THIS checkout or worktree — gitignored here,
 * so the companion's own `.git` never shows up in the public tree, and each
 * worktree gets its own clone (the ApexRacers convention). `private/` is also
 * the default `ASHEBROOK_PRIVATE_ROOT`, so resident-derived records the import
 * tooling reads and writes land inside the companion clone; the companion's
 * `.gitignore` excludes those families by name, and its README forbids
 * committing them.
 *
 * Records seeding: those record families (`HOA_files/`, `rag_corpus/`, the
 * generated SQL/manifests) are NOT in the companion — they are resident data
 * kept out of every Git repository — so a linked worktree gets them from the
 * MAIN checkout's `private/` (`git rev-parse --git-common-dir`'s parent),
 * which the operator populates once per machine from the encrypted snapshot
 * (see the companion's `operations/recovery.md`). Files are HARDLINKED by
 * default — no extra disk, and an edit is visible from every worktree, which
 * is what a source record wants — or copied with `--copy`. The source can be
 * overridden with `--records-from <dir>` / `ASHEBROOK_RECORDS_SOURCE`; a
 * source that has no records is reported and skipped. Existing files in the
 * target are left alone.
 *
 * Usage:
 *
 *   npm run bootstrap:private                 # clone the companion if absent
 *   npm run bootstrap:env                     # ...then materialize .env/.dev.vars
 *   npm run bootstrap:private -- --target <dir>   # or ASHEBROOK_OPS_ROOT
 *   npm run bootstrap:private -- --records-from <dir> --copy   # or ASHEBROOK_RECORDS_SOURCE
 *   npm run bootstrap:private -- --no-records
 *   npm run bootstrap:private -- --op-reference <op://...>
 *   npm run bootstrap:private -- --url <credential-free github url>
 *
 * `--materialize` (what `bootstrap:env` passes) runs the companion's
 * `scripts/bootstrap.ps1` against THIS worktree root, which is what a fresh
 * worktree needs — it validates every referenced 1Password field and reports
 * variable names only, never values. It needs `pwsh` on PATH.
 *
 * If the current `op` identity cannot read the locator, the optional
 * `ASHEBROOK_OP_SERVICE_ACCOUNT_REFERENCE` (or `--service-account-reference`)
 * names an `op://` field holding a service-account token; it is read into
 * process memory for one retry and never written anywhere.
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMPANION_NAME = 'valleys-at-ashebrook-hoa-ops';
export const DEFAULT_LOCATOR_REFERENCE =
  'op://Ashebrook/Workstation Bootstrap/PRIVATE_REPOSITORY_URL';
export const SERVICE_ACCOUNT_REFERENCE_ENV =
  'ASHEBROOK_OP_SERVICE_ACCOUNT_REFERENCE';
export const OPS_ROOT_ENV = 'ASHEBROOK_OPS_ROOT';
export const DEFAULT_TARGET = 'private';
export const RECORDS_SOURCE_ENV = 'ASHEBROOK_RECORDS_SOURCE';

/** Directories and file globs that make up the resident-records working copy. */
export const RECORD_DIRECTORIES = [
  'HOA_files',
  'rag_corpus',
  'backups',
  'portability',
] as const;
export const RECORD_FILE_PATTERNS: readonly RegExp[] = [
  /\.sql$/u,
  /^documents-.*\.json$/u,
  /^dedupe-/u,
];

export interface Options {
  url: string | null;
  reference: string;
  serviceAccountReference: string | null;
  target: string | null;
  materialize: boolean;
  force: boolean;
  recordsFrom: string | null;
  seedRecords: boolean;
  copyRecords: boolean;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function parseArgs(
  argv: readonly string[],
  env: EnvLike = process.env,
): Options {
  const options: Options = {
    url: null,
    reference: DEFAULT_LOCATOR_REFERENCE,
    serviceAccountReference: env[SERVICE_ACCOUNT_REFERENCE_ENV] ?? null,
    target: env[OPS_ROOT_ENV]?.trim() || null,
    materialize: false,
    force: false,
    recordsFrom: env[RECORDS_SOURCE_ENV]?.trim() || null,
    seedRecords: true,
    copyRecords: false,
  };
  const valued = new Set([
    '--url',
    '--op-reference',
    '--service-account-reference',
    '--target',
    '--records-from',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--materialize') {
      options.materialize = true;
      continue;
    }
    if (argument === '--force') {
      options.force = true;
      continue;
    }
    if (argument === '--no-records') {
      options.seedRecords = false;
      continue;
    }
    if (argument === '--copy') {
      options.copyRecords = true;
      continue;
    }
    if (!valued.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--url') options.url = value;
    else if (argument === '--op-reference') options.reference = value;
    else if (argument === '--target') options.target = value;
    else if (argument === '--records-from') options.recordsFrom = value;
    else options.serviceAccountReference = value;
    index += 1;
  }
  return options;
}

/**
 * Accept only a credential-free GitHub locator. An HTTPS URL with an embedded
 * token would land in `.git/config` of the clone; an SSH URL is fine because
 * the credential lives in the agent, not the string.
 */
export function validateCloneUrl(cloneUrl: string): string {
  if (/\r|\n/u.test(cloneUrl)) {
    throw new Error('The clone URL must be a single line.');
  }
  if (/^https?:\/\//iu.test(cloneUrl)) {
    const parsed = new URL(cloneUrl);
    if (
      parsed.hostname.toLowerCase() !== 'github.com' ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error(
        'The HTTPS clone URL must target github.com and contain no embedded credential.',
      );
    }
    return cloneUrl;
  }
  if (
    !/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u.test(
      cloneUrl,
    )
  ) {
    throw new Error(
      'The clone URL must be a credential-free GitHub HTTPS or SSH URL.',
    );
  }
  return cloneUrl;
}

/**
 * The main checkout's root, even when invoked from a linked worktree: the
 * common git dir is `<main>/.git` for the main checkout and every worktree,
 * so its parent is where the machine's records copy lives.
 */
export function mainRepositoryRoot(worktreeRoot: string): string {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) return worktreeRoot;
  return path.dirname(path.resolve(worktreeRoot, result.stdout.trim()));
}

export function isRecordEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return (RECORD_DIRECTORIES as readonly string[]).includes(name);
  }
  return RECORD_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export interface SeedResult {
  linked: number;
  skipped: number;
  families: string[];
}

function placeFile(from: string, to: string, copy: boolean): void {
  if (copy) {
    copyFileSync(from, to);
    return;
  }
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to); // cross-device or unsupported: fall back to a copy
  }
}

function seedTree(
  from: string,
  to: string,
  copy: boolean,
  result: SeedResult,
): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) {
      seedTree(source, destination, copy, result);
    } else if (entry.isFile()) {
      if (existsSync(destination)) {
        result.skipped += 1;
      } else {
        placeFile(source, destination, copy);
        result.linked += 1;
      }
    }
  }
}

/**
 * Hardlink (or copy) the record families from `source` into `target`,
 * never overwriting. Same-path is a no-op — the main checkout seeding itself.
 */
export function seedRecords(
  source: string,
  target: string,
  copy: boolean,
): SeedResult {
  const result: SeedResult = { linked: 0, skipped: 0, families: [] };
  if (!existsSync(source) || path.resolve(source) === path.resolve(target)) {
    return result;
  }
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!isRecordEntry(entry.name, entry.isDirectory())) continue;
    result.families.push(entry.name);
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      seedTree(from, to, copy, result);
    } else if (statSync(from).isFile()) {
      if (existsSync(to)) result.skipped += 1;
      else {
        placeFile(from, to, copy);
        result.linked += 1;
      }
    }
  }
  return result;
}

export type InstallState = 'installed' | 'absent' | 'occupied';

export function inspectTarget(target: string): InstallState {
  if (existsSync(path.join(target, '.git'))) return 'installed';
  if (existsSync(target) && readdirSync(target).length > 0) return 'occupied';
  return 'absent';
}

function opRead(reference: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('op', ['read', reference], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value ? value : null;
}

/** Resolve the locator without ever printing it. */
export function readLocator(options: Options): string {
  if (options.url) return options.url;
  let value = opRead(options.reference, process.env);
  if (!value && options.serviceAccountReference) {
    let token = opRead(options.serviceAccountReference, process.env);
    if (token) {
      const elevated = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token };
      value = opRead(options.reference, elevated);
      elevated.OP_SERVICE_ACCOUNT_TOKEN = '';
      token = '';
    }
  }
  if (!value) {
    throw new Error(
      'Could not retrieve the companion clone URL with the current 1Password identity or the optional service-account reference.',
    );
  }
  return value;
}

export function materializeEnv(
  companionRoot: string,
  worktreeRoot: string,
  force: boolean,
): void {
  const bootstrap = path.join(companionRoot, 'scripts', 'bootstrap.ps1');
  if (!existsSync(bootstrap)) {
    throw new Error(
      'The companion has no scripts/bootstrap.ps1; update the companion clone first.',
    );
  }
  const args = [
    '-NoProfile',
    '-File',
    bootstrap,
    '-PublicRepositoryRoot',
    worktreeRoot,
  ];
  if (force) args.push('-Force');
  const result = spawnSync('pwsh', args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      'pwsh is required to materialize .env/.dev.vars; install PowerShell 7 or run the companion bootstrap by hand.',
    );
  }
  if (result.status !== 0) {
    throw new Error('The companion bootstrap did not complete successfully.');
  }
}

export function main(argv: readonly string[]): void {
  const options = parseArgs(argv);
  const worktreeRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const companionRoot = path.resolve(
    worktreeRoot,
    options.target ?? DEFAULT_TARGET,
  );

  const state = inspectTarget(companionRoot);
  if (state === 'occupied') {
    throw new Error(
      `Refusing to overwrite the non-empty directory ${companionRoot} because it is not a Git worktree.`,
    );
  }
  if (state === 'installed') {
    console.log(
      `The private companion is already installed at ${companionRoot}.`,
    );
  } else {
    const cloneUrl = validateCloneUrl(readLocator(options));
    const clone = spawnSync('git', ['clone', cloneUrl, companionRoot], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (clone.status !== 0 || inspectTarget(companionRoot) !== 'installed') {
      throw new Error(
        'The private companion clone did not complete successfully.',
      );
    }
    console.log(`Private companion installed at ${companionRoot}.`);
  }

  if (options.seedRecords) {
    const source = path.resolve(
      worktreeRoot,
      options.recordsFrom ??
        path.join(mainRepositoryRoot(worktreeRoot), DEFAULT_TARGET),
    );
    const seeded = seedRecords(source, companionRoot, options.copyRecords);
    if (seeded.families.length === 0) {
      console.log(
        `No record families found at ${source}; restore the snapshot there first (see the companion's operations/recovery.md).`,
      );
    } else {
      console.log(
        `Records ${options.copyRecords ? 'copied' : 'linked'} from ${source}: ${seeded.families.join(', ')} (${seeded.linked} files, ${seeded.skipped} already present).`,
      );
    }
  }

  if (options.materialize) {
    materializeEnv(companionRoot, worktreeRoot, options.force);
  } else {
    console.log(
      'Next: `npm run bootstrap:env` materializes .env and .dev.vars for this worktree from 1Password.',
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
