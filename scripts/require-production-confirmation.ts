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

/**
 * Classify shell commands that may change production or expose its credentials to new code.
 * The hook asks the user rather than denying them: agents are authorized production operators,
 * but the decision to perform each high-impact mutation stays with the user.
 */
export function productionConfirmationReason(command: string): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();

  if (/\bnpm\s+(?:install|i)(?:\s|$)/.test(normalized)) {
    return 'execute dependency lifecycle scripts while production credentials are available';
  }

  if (/\bnpm\s+run\s+deploy(?:\s|$)/.test(normalized)) {
    return 'deploy the application to production';
  }
  if (/\bnpm\s+run\s+db:migrate:remote(?:\s|$)/.test(normalized)) {
    return 'apply migrations to production D1';
  }
  if (/\bnpm\s+run\s+secrets:put(?:\s|$)/.test(normalized)) {
    return 'replace a production Worker secret';
  }

  const commitImport =
    /\bnpm\s+run\s+(?:corpus:import|docs:import|docs:dedupe|ocr:scanned)(?:\s|$)/;
  if (commitImport.test(normalized) && /--(?:commit|wipe)\b/.test(normalized)) {
    return 'write or clean-replace production document data';
  }

  const remoteRosterWrite =
    /\bnpm\s+run\s+(?:roster:backfill|shadow:sweep)(?:\s|$)/;
  if (
    remoteRosterWrite.test(normalized) &&
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

  const wrangler = /\b(?:npx\s+)?wrangler\s+/;
  if (wrangler.test(normalized)) {
    if (
      /\bwrangler\s+(?:deploy|delete|rollback)\b/.test(normalized) &&
      !/--dry-run\b/.test(normalized)
    ) {
      return 'change or remove a production Worker deployment';
    }
    if (/\bversions\s+deploy\b/.test(normalized)) {
      return 'change the production Worker version';
    }
    if (
      /\bd1\s+(?:execute|migrations\s+apply)\b/.test(normalized) &&
      /--remote\b/.test(normalized)
    ) {
      return 'write or migrate production D1';
    }
    if (/\bsecret\s+(?:put|bulk|delete)\b/.test(normalized)) {
      return 'change production Worker secrets';
    }
    if (
      /\br2\s+(?:object\s+(?:put|delete)|bucket\s+(?:create|delete))\b/.test(
        normalized,
      )
    ) {
      return 'change production R2 data or buckets';
    }
    if (
      /\bkv\s+(?:key\s+(?:put|delete)|namespace\s+(?:create|delete))\b/.test(
        normalized,
      )
    ) {
      return 'change production KV data or namespaces';
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
