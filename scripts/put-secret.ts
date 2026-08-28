/**
 * Deploy one Worker secret from 1Password without the value ever touching a
 * command line, a file, or this process's output.
 *
 *   npm run secrets:put -- ANTHROPIC_API_KEY
 *
 * Where the value comes from: the private companion's `.dev.vars.tpl`
 * (`private/config/1password/.dev.vars.tpl`, installed by
 * `npm run bootstrap:private`) maps every secret NAME to an `op://` reference,
 * so that template is the single source of truth for "which 1Password field
 * holds NAME" — the same one `bootstrap:env` materializes local config from.
 * A NAME the template does not list is refused rather than guessed.
 *
 * How it reaches Cloudflare: `wrangler secret put NAME` reads the value from
 * STDIN, and authenticates through the `CLOUDFLARE_API_TOKEN` (and
 * `CLOUDFLARE_ACCOUNT_ID`) environment variables. Both are read from the
 * Ashebrook `Cloudflare Production` item into memory for the one child process
 * and never printed. Override the references with `--token-reference` /
 * `--account-reference`, or the template path with `--template`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_TOKEN_REFERENCE =
  'op://Ashebrook/Cloudflare Production/CLOUDFLARE_API_TOKEN';
export const DEFAULT_ACCOUNT_REFERENCE =
  'op://Ashebrook/Cloudflare Production/CLOUDFLARE_ACCOUNT_ID';
export const DEFAULT_TEMPLATE = path.join(
  'private',
  'config',
  '1password',
  '.dev.vars.tpl',
);

export interface Options {
  name: string;
  template: string;
  tokenReference: string;
  accountReference: string;
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    name: '',
    template: DEFAULT_TEMPLATE,
    tokenReference: DEFAULT_TOKEN_REFERENCE,
    accountReference: DEFAULT_ACCOUNT_REFERENCE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      if (options.name) throw new Error('Exactly one secret name is expected.');
      options.name = argument;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--template') options.template = value;
    else if (argument === '--token-reference') options.tokenReference = value;
    else if (argument === '--account-reference')
      options.accountReference = value;
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!/^[A-Z][A-Z0-9_]*$/u.test(options.name)) {
    throw new Error(
      'Pass the secret name as the single argument, e.g. `npm run secrets:put -- ANTHROPIC_API_KEY`.',
    );
  }
  return options;
}

/** `NAME={{ op://vault/item/field }}` lines → NAME → reference. */
export function parseTemplate(text: string): Map<string, string> {
  const references = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match =
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\{\s*(op:\/\/[^}]+?)\s*\}\}\s*$/u.exec(
        line,
      );
    if (match) references.set(match[1], match[2]);
  }
  return references;
}

function opRead(reference: string): string {
  const result = spawnSync('op', ['read', reference], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const value = result.status === 0 ? result.stdout.replace(/\r?\n$/u, '') : '';
  if (!value) {
    throw new Error(
      `Could not read ${reference.replace(/\/[^/]+$/u, '/<field>')} with the current 1Password identity.`,
    );
  }
  return value;
}

export function main(argv: readonly string[]): void {
  const options = parseArgs(argv);
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const templatePath = path.resolve(repositoryRoot, options.template);
  if (!existsSync(templatePath)) {
    throw new Error(
      `${options.template} is missing; run \`npm run bootstrap:private\` to install the companion first.`,
    );
  }
  const references = parseTemplate(readFileSync(templatePath, 'utf8'));
  const reference = references.get(options.name);
  if (!reference) {
    throw new Error(
      `${options.name} is not declared in ${options.template}; declared names: ${[...references.keys()].join(', ')}.`,
    );
  }

  let value = opRead(reference);
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: opRead(options.tokenReference),
    CLOUDFLARE_ACCOUNT_ID: opRead(options.accountReference),
  };
  const wrangler = path.join(
    repositoryRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
  );
  const result = spawnSync(wrangler, ['secret', 'put', options.name], {
    cwd: repositoryRoot,
    env,
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  value = '';
  env.CLOUDFLARE_API_TOKEN = '';
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler secret put ${options.name} failed.`);
  }
  console.log(`deployed ${options.name}`);
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
