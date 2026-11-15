import path from 'node:path';
import { pathToFileURL } from 'node:url';

type HookInput = {
  tool_name?: unknown;
  tool_input?: {
    command?: unknown;
  };
};

function hasFlags(command: string, ...flags: string[]): boolean {
  return flags.every((flag) => command.includes(flag));
}

function shellWords(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((word) =>
    word.replace(/^(['"])(.*)\1$/, '$2'),
  );
}

function executableIndex(words: string[], executable: string): number {
  return words.findIndex((word) => {
    const basename = word.replaceAll('\\', '/').split('/').at(-1);
    return basename === executable || basename === `${executable}.cmd`;
  });
}

// Every word npm 12 resolves to `run` (its `deref` in `lib/utils/cmd-list.js`): the aliases
// `run-script`, `rum` and `urn`, and the unique abbreviations `ur` and `run-` through
// `run-scrip`. npm first turns camelCase into kebab-case, so `runScript` counts too.
const RUN_COMMAND =
  /^(?:run(?:-(?:s(?:c(?:r(?:i(?:p(?:t)?)?)?)?)?)?)?|rum|urn|ur)$/;

function isRunCommand(word: string): boolean {
  return RUN_COMMAND.test(
    word.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
  );
}

type NpmPositional = {
  word: string;
  /** It directly follows a flag written without `=`, so it may be that flag's value. */
  mayBeFlagValue: boolean;
};

/**
 * npm's arguments as its option parser reads them, without knowing which flags take a value:
 * the flags before the first bare `--`, and the positional words — every other word before it,
 * and every word after it, since `--` only ends npm's options. Commands are found among the
 * positional words by presence rather than position, because a value-taking flag such as
 * `--prefix <dir>` can stand between `npm` and its command (#588).
 */
function parseNpmArguments(argumentsAfterNpm: string[]): {
  flags: string[];
  positional: NpmPositional[];
} {
  const flags: string[] = [];
  const positional: NpmPositional[] = [];
  let endOfOptions = false;
  let afterFlag = false;
  for (const word of argumentsAfterNpm) {
    if (!endOfOptions && word === '--') {
      endOfOptions = true;
      afterFlag = false;
    } else if (!endOfOptions && word.startsWith('-')) {
      flags.push(word);
      afterFlag = !word.includes('=');
    } else {
      positional.push({ word, mayBeFlagValue: afterFlag });
      afterFlag = false;
    }
  }
  return { flags, positional };
}

/**
 * The words that could name the script an `npm run` command runs: the positional words after
 * `run` up to the first that cannot be a flag's value, which is the script name; the words after
 * it are the script's own arguments. Empty when the command runs no script. Callers match a gated
 * script name exactly among them, so a value-taking flag on either side of `run`
 * (`-w <workspace>`) cannot hide it; a folder or workspace named like a gated script only adds a
 * prompt (#588).
 */
function npmRunScriptCandidates(words: string[]): string[] {
  const npmIndex = executableIndex(words, 'npm');
  if (npmIndex < 0) return [];

  const { positional } = parseNpmArguments(words.slice(npmIndex + 1));
  const runIndex = positional.findIndex(({ word }) => isRunCommand(word));
  if (runIndex < 0) return [];

  const candidates: string[] = [];
  for (const { word, mayBeFlagValue } of positional.slice(runIndex + 1)) {
    candidates.push(word);
    // After npm's `--`, npm 12 takes even a flag-shaped word (`npm -- run --silent deploy`) as the
    // script name, so `deploy` never runs; looking past it anyway costs a prompt, never a miss.
    if (!mayBeFlagValue && !word.startsWith('-')) break;
  }
  return candidates;
}

// npm 12's settings that let dependency install scripts run despite the `allowScripts` policy:
// `allow-scripts` adds packages to it, `dangerously-allow-all-scripts` ignores it. Each can be a
// flag, an `npm config set` key, or an `npm_config_*` variable. `--allow-scripts-pending` and
// `--allow-scripts-pin` only list or pin, and `--no-…` turns a setting off, so none of them match.
const SCRIPT_SWITCH_FLAG =
  /^--(?:dangerously-allow-all-scripts|allow-scripts)(?:=|$)/i;
const SCRIPT_SWITCH_CONFIG_KEY =
  /^(?:dangerously-allow-all-scripts|allow-scripts)(?:=|$)/i;
const SCRIPT_SWITCH_VARIABLE =
  /^npm_config_(?:dangerously_allow_all_scripts|allow_scripts)=/i;

/**
 * Whether a command segment lets dependency install scripts run. Plain installs are not gated:
 * npm 12 blocks every dependency's install scripts until they are approved, so changing the
 * dependency tree runs no dependency code. Approving those scripts, or switching the policy off,
 * is what lets them run (#586). A `package.json` or `.npmrc` edited outside a command is left to
 * review of the diff.
 */
function enablesInstallScripts(words: string[]): boolean {
  // An exported or inline variable applies to whatever npm runs next in the same shell.
  if (words.some((word) => SCRIPT_SWITCH_VARIABLE.test(word))) return true;

  const npmIndex = executableIndex(words, 'npm');
  const npxIndex = executableIndex(words, 'npx');
  const commandIndex = npmIndex >= 0 ? npmIndex : npxIndex;
  if (commandIndex < 0) return false;

  // Flags after `--` belong to a script or binary, not to npm.
  const { flags, positional: positionalWords } = parseNpmArguments(
    words.slice(commandIndex + 1),
  );
  if (flags.some((word) => SCRIPT_SWITCH_FLAG.test(word))) return true;
  if (npmIndex < 0) return false;

  const positional = positionalWords.map(({ word }) => word);
  const after = (command: string): string[] => {
    const index = positional.indexOf(command);
    return index < 0 ? [] : positional.slice(index + 1);
  };

  if (positional.includes('approve-scripts')) {
    return !flags.includes('--allow-scripts-pending');
  }
  if (after('install-scripts')[0] === 'approve') return true;

  const config = after('config');
  if (config[0] === 'set') {
    return config.slice(1).some((word) => SCRIPT_SWITCH_CONFIG_KEY.test(word));
  }
  const pkg = after('pkg');
  if (pkg[0] === 'set') {
    return pkg.slice(1).some((word) => /^allowScripts(?:[.[=]|$)/.test(word));
  }
  return false;
}

function wranglerArguments(words: string[]): string[] | null {
  const wranglerIndex = executableIndex(words, 'wrangler');
  return wranglerIndex < 0 ? null : words.slice(wranglerIndex + 1);
}

function isReadOnlyWrangler(argumentsAfterWrangler: string[]): boolean {
  const command = argumentsAfterWrangler.join(' ');

  if (/^(?:--help|-h|--version|-v)(?:\s|$)/.test(command)) return true;
  if (/(?:^|\s)(?:--help|-h|--version)(?:\s|$)/.test(command)) return true;
  if (/(?:^|\s)--dry-run(?:\s|$)/.test(command)) return true;
  if (/^(?:whoami|tail|types|docs|check)(?:\s|$)/.test(command)) return true;
  if (
    /^dev(?:\s|$)/.test(command) &&
    !/(?:^|\s)--remote(?:\s|$)/.test(command)
  ) {
    return true;
  }
  if (/^d1\s+(?:list|info|export)(?:\s|$)/.test(command)) return true;
  if (/^d1\s+migrations\s+(?:list|create)(?:\s|$)/.test(command)) {
    return true;
  }
  if (
    /^d1\s+(?:execute|migrations\s+apply)(?:\s|$)/.test(command) &&
    /(?:^|\s)--local(?:\s|$)/.test(command) &&
    !/(?:^|\s)--remote(?:\s|$)/.test(command)
  ) {
    return true;
  }
  if (/^secret\s+list(?:\s|$)/.test(command)) return true;
  if (/^kv\s+(?:namespace\s+list|key\s+(?:get|list))(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^r2\s+(?:bucket\s+(?:list|info)|object\s+get)(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^vectorize\s+(?:list|get|query)(?:\s|$)/.test(command)) return true;
  if (/^hyperdrive\s+(?:list|get)(?:\s|$)/.test(command)) return true;
  if (/^queues\s+(?:list|info)(?:\s|$)/.test(command)) return true;
  if (/^containers\s+(?:list|info)(?:\s|$)/.test(command)) return true;
  if (/^containers\s+(?:images|registries)\s+list(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^workflows\s+(?:list|describe)(?:\s|$)/.test(command)) return true;
  if (/^workflows\s+instances\s+(?:list|describe)(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^pipelines\s+(?:list|show)(?:\s|$)/.test(command)) return true;
  if (
    /^secrets-store\s+(?:store\s+list|secret\s+(?:list|get))(?:\s|$)/.test(
      command,
    )
  ) {
    return true;
  }
  if (/^pages\s+(?:project|deployment)\s+list(?:\s|$)/.test(command)) {
    return true;
  }

  return false;
}

/**
 * Classify shell commands that may change production or expose its credentials to new code.
 * The hook asks the user rather than denying them: agents are authorized production operators,
 * but the decision to perform each high-impact mutation stays with the user.
 */
export function productionConfirmationReason(command: string): string | null {
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/);
  for (const segment of segments) {
    const reason = productionConfirmationReasonForSegment(segment);
    if (reason) return reason;
  }
  return null;
}

function productionConfirmationReasonForSegment(
  command: string,
): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const words = shellWords(normalized);
  if (enablesInstallScripts(words)) {
    return 'let dependency install scripts run while production credentials are available';
  }

  const scriptCandidates = npmRunScriptCandidates(words);
  const runs = (script: string): boolean => scriptCandidates.includes(script);

  if (runs('deploy')) {
    return 'deploy the application to production';
  }
  if (runs('db:migrate:remote')) {
    return 'apply migrations to production D1';
  }
  if (runs('secrets:put')) {
    return 'replace a production Worker secret';
  }

  const productionImport = new Set([
    'corpus:import',
    'docs:import',
    'docs:dedupe',
    'ocr:scanned',
  ]);
  if (
    scriptCandidates.some((script) => productionImport.has(script)) &&
    /--(?:commit|wipe)\b/.test(normalized)
  ) {
    return 'write or clean-replace production document data';
  }

  if (runs('roster:backfill') && hasFlags(normalized, '--remote', '--write')) {
    return 'write production roster or access-audit data';
  }

  const directScript =
    /\bscripts[\\/](?:put-secret|import-corpus|import-documents|dedupe-documents|ocr-scanned|migrate-roster)\.ts\b/;
  if (
    directScript.test(normalized) &&
    (/put-secret\.ts\b/.test(normalized) ||
      /--(?:commit|wipe)\b/.test(normalized) ||
      hasFlags(normalized, '--remote', '--write'))
  ) {
    return 'invoke a production-mutating operator script directly';
  }

  const wrangler = wranglerArguments(words);
  if (wrangler) {
    const wranglerCommand = wrangler.join(' ');
    if (
      /^(?:deploy|delete|rollback)(?:\s|$)/.test(wranglerCommand) &&
      !/(?:^|\s)--dry-run(?:\s|$)/.test(wranglerCommand)
    ) {
      return 'change or remove a production Worker deployment';
    }
    if (/^versions\s+deploy(?:\s|$)/.test(wranglerCommand)) {
      return 'change the production Worker version';
    }
    if (
      /^d1\s+(?:execute|migrations\s+apply)(?:\s|$)/.test(wranglerCommand) &&
      /(?:^|\s)--remote(?:\s|$)/.test(wranglerCommand)
    ) {
      return 'write or migrate production D1';
    }
    if (/^secret\s+(?:put|bulk|delete)(?:\s|$)/.test(wranglerCommand)) {
      return 'change production Worker secrets';
    }
    if (!isReadOnlyWrangler(wrangler)) {
      return 'perform a Cloudflare management operation that is not classified as read-only';
    }
  }

  return null;
}

async function runHook(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  const input = JSON.parse(raw) as HookInput;
  if (input.tool_name !== 'Bash') return;
  if (typeof input.tool_input?.command !== 'string') {
    throw new Error('Bash hook input did not contain a command string.');
  }

  const reason = productionConfirmationReason(input.tool_input.command);
  if (!reason) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `Explicit confirmation required: this command may ${reason}.`,
      },
    }),
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (entryPoint === import.meta.url) {
  runHook().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
