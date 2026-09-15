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

function npmOperation(
  words: string[],
): { kind: 'install' | 'run'; name?: string } | null {
  const npmIndex = executableIndex(words, 'npm');
  if (npmIndex < 0) return null;

  const argumentsAfterNpm = words.slice(npmIndex + 1);
  const operationIndex = argumentsAfterNpm.findIndex(
    (word) => !word.startsWith('-'),
  );
  const operation = argumentsAfterNpm[operationIndex];
  if (operation === 'install' || operation === 'i') return { kind: 'install' };
  if (operation !== 'run') return null;

  const scriptName = argumentsAfterNpm
    .slice(operationIndex + 1)
    .find((word) => !word.startsWith('-'));
  return { kind: 'run', name: scriptName };
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
  const npm = npmOperation(words);

  if (npm?.kind === 'install') {
    return 'execute dependency lifecycle scripts while production credentials are available';
  }

  if (npm?.kind === 'run' && npm.name === 'deploy') {
    return 'deploy the application to production';
  }
  if (npm?.kind === 'run' && npm.name === 'db:migrate:remote') {
    return 'apply migrations to production D1';
  }
  if (npm?.kind === 'run' && npm.name === 'secrets:put') {
    return 'replace a production Worker secret';
  }

  const productionImport = new Set([
    'corpus:import',
    'docs:import',
    'docs:dedupe',
    'ocr:scanned',
  ]);
  if (
    npm?.kind === 'run' &&
    npm.name &&
    productionImport.has(npm.name) &&
    /--(?:commit|wipe)\b/.test(normalized)
  ) {
    return 'write or clean-replace production document data';
  }

  if (
    npm?.kind === 'run' &&
    (npm.name === 'roster:backfill' || npm.name === 'shadow:sweep') &&
    hasFlags(normalized, '--remote', '--write')
  ) {
    return 'write production roster or access-audit data';
  }

  const directScript =
    /\bscripts[\\/](?:put-secret|import-corpus|import-documents|dedupe-documents|ocr-scanned|migrate-roster|shadow-sweep)\.ts\b/;
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
