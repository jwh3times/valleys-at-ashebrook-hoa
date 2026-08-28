/**
 * Install the private operations companion beside this checkout, and
 * optionally materialize `.env`/`.dev.vars` from 1Password through it.
 *
 * The private companion (a separate private GitHub repository) holds the
 * operational runbooks, design history, and the 1Password secret-reference
 * templates the public tree must never carry. Its locator is deliberately NOT
 * committed here: it is read at run time from the Ashebrook vault's
 * `Workstation Bootstrap` item through the 1Password CLI, so this file names
 * only an `op://` reference, never a URL.
 *
 * Where it goes: a SIBLING of the main repository root, named after the
 * companion — `../valleys-at-ashebrook-hoa-ops` — the convention the private
 * recovery runbook and its bootstrap script both assume. Worktrees resolve the
 * MAIN checkout (`git rev-parse --git-common-dir`), so every worktree shares
 * one companion clone rather than each cloning its own. `private/` under this
 * repository is not used for the companion: that directory is the default
 * `ASHEBROOK_PRIVATE_ROOT`, reserved for resident-derived records that must
 * never enter any Git repository.
 *
 * Usage:
 *
 *   npm run bootstrap:private                 # clone the companion if absent
 *   npm run bootstrap:env                     # ...then materialize .env/.dev.vars
 *   npm run bootstrap:private -- --target <dir>
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

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMPANION_NAME = 'valleys-at-ashebrook-hoa-ops';
export const DEFAULT_LOCATOR_REFERENCE =
  'op://Ashebrook/Workstation Bootstrap/PRIVATE_REPOSITORY_URL';
export const SERVICE_ACCOUNT_REFERENCE_ENV =
  'ASHEBROOK_OP_SERVICE_ACCOUNT_REFERENCE';
export const OPS_ROOT_ENV = 'ASHEBROOK_OPS_ROOT';

export interface Options {
  url: string | null;
  reference: string;
  serviceAccountReference: string | null;
  target: string | null;
  materialize: boolean;
  force: boolean;
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
  };
  const valued = new Set([
    '--url',
    '--op-reference',
    '--service-account-reference',
    '--target',
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
    if (!valued.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--url') options.url = value;
    else if (argument === '--op-reference') options.reference = value;
    else if (argument === '--target') options.target = value;
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
 * so its parent is where the sibling companion belongs.
 */
export function mainRepositoryRoot(worktreeRoot: string): string {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) return worktreeRoot;
  const commonDir = path.resolve(worktreeRoot, result.stdout.trim());
  return path.dirname(commonDir);
}

export function defaultCompanionRoot(mainRoot: string): string {
  return path.join(path.dirname(mainRoot), COMPANION_NAME);
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
  const mainRoot = mainRepositoryRoot(worktreeRoot);
  const companionRoot = path.resolve(
    mainRoot,
    options.target ?? defaultCompanionRoot(mainRoot),
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
