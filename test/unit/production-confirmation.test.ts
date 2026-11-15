import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hookConfirmationReason,
  productionConfirmationReason,
} from '../../scripts/require-production-confirmation';

const throughTool = (tool_name: string, command: string): string | null =>
  hookConfirmationReason({ tool_name, tool_input: { command } });

describe('production confirmation hook', () => {
  it('is registered for every tool, without the blanket npm-run approval it guards', () => {
    const settings = JSON.parse(
      readFileSync(
        path.resolve(process.cwd(), '.claude/settings.json'),
        'utf8',
      ),
    ) as {
      permissions: { allow: string[] };
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ command: string }>;
        }>;
      };
    };

    expect(settings.permissions.allow).not.toContain('Bash(npm run:*)');
    expect(settings.hooks.PreToolUse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matcher: '*',
          hooks: expect.arrayContaining([
            expect.objectContaining({
              command: expect.stringContaining(
                'require-production-confirmation.ts',
              ),
            }),
          ]),
        }),
      ]),
    );
  });

  // Vitest compiles TypeScript fully, but Claude Code runs the hook with Node's type stripping,
  // which rejects some syntax. Matched to every tool, a hook that fails to load blocks every call.
  it('loads and answers when run the way Claude Code runs it', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        'scripts/require-production-confirmation.ts',
      ],
      {
        input: JSON.stringify({
          tool_name: 'PowerShell',
          tool_input: { command: 'npm run deploy' },
        }),
        encoding: 'utf8',
      },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          'Explicit confirmation required: this command may deploy the application to production.',
      },
    });
  });

  it.each([
    'npm run deploy',
    'npm run db:migrate:remote',
    'npm run secrets:put -- ANTHROPIC_API_KEY',
    'npm run corpus:import -- --commit --wipe',
    'npm run docs:dedupe -- --commit',
    'npm run roster:backfill -- --remote --write --operator=operator-id',
    'npx wrangler deploy -c dist/server/wrangler.json',
    'npx --yes wrangler deploy -c dist/server/wrangler.json',
    'wrangler d1 execute DATABASE --remote --file migration.sql',
    'wrangler d1 delete DATABASE',
    'wrangler d1 time-travel restore DATABASE --bookmark=example',
    'wrangler queues delete hoa-events',
    'wrangler vectorize delete hoa-documents',
    'wrangler pages project delete resident-site',
    'wrangler future-resource mutate production',
    'node --experimental-strip-types scripts/put-secret.ts EMAIL_API_KEY',
    'npm --silent run deploy',
    'npm --prefix . run deploy',
    'npm -C . run deploy',
    'npm --workspace x run deploy',
    'npm --prefix . run db:migrate:remote',
    'npm --prefix . run secrets:put -- KEY',
    'npm --prefix . run corpus:import -- --commit',
    'npm --prefix . run roster:backfill -- --remote --write --operator=operator-id',
    'npm run -w x deploy',
    'npm run --workspace x db:migrate:remote',
    'npm run-script deploy',
    'npm rum deploy',
    'npm urn deploy',
    'npm ur deploy',
    'npm run-s deploy',
    'npm runScript deploy',
    // npm reads every word after a bare `--` as positional, so the script can follow it.
    'npm run -- deploy',
    'npm -- run deploy',
    'npm --prefix . -- run deploy',
    'npm run -w x -- deploy',
    'npm run-script -- db:migrate:remote',
    'npm run -- secrets:put KEY',
    'npm run -- corpus:import --commit',
    'npm run -- roster:backfill --remote --write --operator=operator-id',
    'npm -- install-scripts approve esbuild',
    'npm install-scripts approve esbuild',
    'npm --silent install-scripts approve esbuild',
    'npm ci && npm install-scripts approve esbuild',
    'npm approve-scripts esbuild',
    'npm approve-scripts --all',
    'npm ci --dangerously-allow-all-scripts',
    'npm update --dangerously-allow-all-scripts=true',
    'npm exec --allow-scripts=canvas example-package',
    'npm exec --allow-scripts canvas example-package',
    'npx --dangerously-allow-all-scripts example-package',
    'npx --allow-scripts=canvas example-package',
    'npm pkg set allowScripts.esbuild=true',
    'npm --prefix vendor/astro-check-ts6 install-scripts approve esbuild',
    'export npm_config_dangerously_allow_all_scripts=true && npm ci',
    'NPM_CONFIG_ALLOW_SCRIPTS=canvas npm exec example-package',
    'npm config set allow-scripts=canvas --location=user',
    'npm config set dangerously-allow-all-scripts true',
    'npm_config_dangerously_allow_all_scripts=true npm ci',
  ])('requires confirmation for %s', (command) => {
    expect(productionConfirmationReason(command)).not.toBeNull();
  });

  it.each([
    'npm run deploy:check',
    'npm run corpus:import',
    'npm run roster:backfill -- --remote',
    'npx wrangler d1 migrations list DATABASE --remote',
    'npx wrangler d1 list',
    'npx wrangler d1 export DATABASE --remote --output backup.sql',
    'npx wrangler tail resident-site',
    'npx wrangler deploy --dry-run',
    'npx wrangler vectorize query hoa-documents --vector "[0.1, 0.2]"',
    'npm ci',
    'npm test',
    'npm --prefix . run deploy:check',
    'npm run -w x test',
    'npm run lint -- deploy',
    'npm run-script deploy:check',
  ])(
    'does not prompt for read-only, local, or verification work: %s',
    (command) => {
      expect(productionConfirmationReason(command)).toBeNull();
    },
  );

  // npm 12 blocks every dependency's install scripts until they are approved, so changing the
  // dependency tree runs no dependency code; approving the scripts is what is gated (#586).
  it.each([
    'npm install',
    'npm install example-package',
    'npm --silent install example-package',
    'npm i example-package',
    'npm add example-package',
    'npm update',
    'npm uninstall example-package',
    'npm install-scripts ls',
    'npm install-scripts deny esbuild',
    'npm approve-scripts --allow-scripts-pending',
    'npm deny-scripts esbuild',
    'npm config get allow-scripts',
    'npm config delete allow-scripts',
    'npm ci --no-dangerously-allow-all-scripts',
    'npm install example-allow-scripts',
    'npm test -- -t "allow-scripts"',
    'npm run lint -- --allow-scripts',
    'npm pkg get allowScripts',
  ])(
    'does not prompt for dependency changes that leave install scripts blocked: %s',
    (command) => {
      expect(productionConfirmationReason(command)).toBeNull();
    },
  );

  it('finds a production mutation inside a compound command', () => {
    expect(
      productionConfirmationReason('npm run check && npm run deploy'),
    ).toContain('deploy');
  });

  it('describes a direct secret deletion as a secret change', () => {
    expect(
      productionConfirmationReason('npx wrangler secret delete API_KEY'),
    ).toContain('secret');
  });

  // Every tool reaches the hook (#592): Monitor runs its command in Bash, and a tool the hook
  // does not know is read as Bash too, since over-prompting is safe and a miss is not.
  it.each(['Monitor', 'SomeFutureShellTool'])(
    'checks the command of the %s tool as Bash',
    (tool) => {
      expect(throughTool(tool, 'npm run deploy')).toBe(
        'deploy the application to production',
      );
      expect(throughTool(tool, 'npm run deploy:check')).toBeNull();
    },
  );

  // Each prompts with its gate's existing reason when run through the PowerShell tool (#592).
  it.each([
    ['npm run deploy', 'deploy the application to production'],
    ['npm.cmd run deploy', 'deploy the application to production'],
    ['NPM run deploy', 'deploy the application to production'],
    ['npm.ps1 run deploy', 'deploy the application to production'],
    ['& npm run deploy', 'deploy the application to production'],
    [
      "& 'C:\\Program Files\\nodejs\\npm.cmd' run deploy",
      'deploy the application to production',
    ],
    ['npm run check; npm run deploy', 'deploy the application to production'],
    ['npm run check\nnpm run deploy', 'deploy the application to production'],
    ['npm run check\r\nnpm run deploy', 'deploy the application to production'],
    ['npm run check && npm run deploy', 'deploy the application to production'],
    [
      'npm run check `\n  ; npm run deploy',
      'deploy the application to production',
    ],
    ['npm run de`ploy', 'deploy the application to production'],
    ["npm run 'de'ploy", 'deploy the application to production'],
    ['npm run "de"ploy', 'deploy the application to production'],
    ['npx wrangler deploy', 'change or remove a production Worker deployment'],
    [
      'npx.cmd wrangler deploy',
      'change or remove a production Worker deployment',
    ],
    [
      '.\\node_modules\\.bin\\wrangler.cmd deploy',
      'change or remove a production Worker deployment',
    ],
    ['npm run db:migrate:remote', 'apply migrations to production D1'],
    ['npm run secrets:put -- KEY', 'replace a production Worker secret'],
    [
      'npm run corpus:import -- --commit',
      'write or clean-replace production document data',
    ],
    [
      'npm run roster:backfill -- --remote --write --operator=operator-id',
      'write production roster or access-audit data',
    ],
    [
      'npm install-scripts approve esbuild',
      'let dependency install scripts run while production credentials are available',
    ],
    // PowerShell runs subexpressions, groups and script blocks, even inside double quotes.
    ['Write-Output $(npm run deploy)', 'deploy the application to production'],
    [
      'Write-Output "$(npm run deploy)"',
      'deploy the application to production',
    ],
    ['Write-Output @(npm run deploy)', 'deploy the application to production'],
    ['(npm run deploy)', 'deploy the application to production'],
    ['& { npm run deploy }', 'deploy the application to production'],
    [
      'Invoke-Command -ScriptBlock { npm run check; npm run deploy }',
      'deploy the application to production',
    ],
    [
      'Write-Output "${env:USERNAME} $(npm run deploy)"',
      'deploy the application to production',
    ],
    [
      'Set-Content f.md @"\nBuilt $(npm run deploy)\n"@',
      'deploy the application to production',
    ],
    [
      "Write-Output 'npm run check' # done\nnpm run deploy",
      'deploy the application to production',
    ],
    // A wrapper runs the string it is given.
    [
      "Invoke-Expression 'npm run deploy'",
      'deploy the application to production',
    ],
    ['iex "npm run deploy"', 'deploy the application to production'],
    [
      "Invoke-Expression -Command 'npm run deploy'",
      'deploy the application to production',
    ],
    ['cmd /c "npm run deploy"', 'deploy the application to production'],
    ['cmd.exe /C npm run deploy', 'deploy the application to production'],
    ['cmd /k "npm run de^ploy"', 'deploy the application to production'],
    ['pwsh -Command "npm run deploy"', 'deploy the application to production'],
    [
      "powershell.exe -NoProfile -c 'npm run deploy'",
      'deploy the application to production',
    ],
    ['bash -c "npm run deploy"', 'deploy the application to production'],
    [
      "& 'C:\\Program Files\\Git\\bin\\bash.exe' -lc 'npm run deploy'",
      'deploy the application to production',
    ],
    [
      "Start-Process npm -ArgumentList 'run','deploy'",
      'deploy the application to production',
    ],
    [
      "Start-Process npm -ArgumentList 'run deploy'",
      'deploy the application to production',
    ],
    [
      "Start-Process -FilePath npm.cmd -ArgumentList 'run deploy' -Wait",
      'deploy the application to production',
    ],
    ["saps npm 'run','deploy'", 'deploy the application to production'],
    [
      "start wrangler.cmd 'deploy'",
      'change or remove a production Worker deployment',
    ],
    // Install-script switches set as PowerShell environment variables.
    [
      "$env:npm_config_dangerously_allow_all_scripts = 'true'; npm ci",
      'let dependency install scripts run while production credentials are available',
    ],
    [
      "$env:NPM_CONFIG_ALLOW_SCRIPTS='canvas'",
      'let dependency install scripts run while production credentials are available',
    ],
    [
      "[Environment]::SetEnvironmentVariable('npm_config_allow_scripts', 'canvas', 'User')",
      'let dependency install scripts run while production credentials are available',
    ],
    [
      "Set-Item env:npm_config_dangerously_allow_all_scripts 'true'",
      'let dependency install scripts run while production credentials are available',
    ],
    // An encoded command cannot be read, so it always prompts.
    [
      'pwsh -EncodedCommand bgBwAG0AIAB0AGUAcwB0AA==',
      'run an encoded PowerShell command the hook cannot read',
    ],
    [
      'powershell -enc bgBwAG0AIAB0AGUAcwB0AA==',
      'run an encoded PowerShell command the hook cannot read',
    ],
    [
      'pwsh -NoProfile -e bgBwAG0AIAB0AGUAcwB0AA==',
      'run an encoded PowerShell command the hook cannot read',
    ],
    [
      'powershell.exe /ec bgBwAG0AIAB0AGUAcwB0AA==',
      'run an encoded PowerShell command the hook cannot read',
    ],
    // Found in review: forms PowerShell runs that the first reading missed.
    ["$null = iex 'npm run deploy'", 'deploy the application to production'],
    ['$o = cmd /c "npm run deploy"', 'deploy the application to production'],
    [
      "$p = Start-Process npm -ArgumentList 'run','deploy' -PassThru",
      'deploy the application to production',
    ],
    [". iex 'npm run deploy'", 'deploy the application to production'],
    [". cmd /c 'npm run deploy'", 'deploy the application to production'],
    ["wsl bash -c 'npm run deploy'", 'deploy the application to production'],
    ["'npm run deploy' | iex", 'deploy the application to production'],
    ["iex -Command:'npm run deploy'", 'deploy the application to production'],
    [
      "Start-Process npm -ArgumentList @('run','deploy')",
      'deploy the application to production',
    ],
    [
      "Start-Process npm -ArgumentList ('run','deploy')",
      'deploy the application to production',
    ],
    [
      "Start-Process npm -ArgumentList:'run deploy'",
      'deploy the application to production',
    ],
    [
      'pwsh --EncodedCommand bgBwAG0AIAB0AGUAcwB0AA==',
      'run an encoded PowerShell command the hook cannot read',
    ],
    [
      'pwsh –EncodedCommand bgBwAG0AIAB0AGUAcwB0AA==',
      'run an encoded PowerShell command the hook cannot read',
    ],
    [
      "Start-Process pwsh -ArgumentList '-enc','bgBwAG0AIAB0AGUAcwB0AA=='",
      'run an encoded PowerShell command the hook cannot read',
    ],
    [
      'cmd /c powershell -enc bgBwAG0AIAB0AGUAcwB0AA==',
      'run an encoded PowerShell command the hook cannot read',
    ],
    [
      'cmd /c "npm run check & npm run deploy"',
      'deploy the application to production',
    ],
    ['cmd /cnpm run deploy', 'deploy the application to production'],
    ['cmd /c"npm run deploy"', 'deploy the application to production'],
    [
      'iex "npm run check`nnpm run deploy"',
      'deploy the application to production',
    ],
    [
      'pwsh -c "npm run check`nnpm run deploy"',
      'deploy the application to production',
    ],
    ['npm 2>&1 run deploy', 'deploy the application to production'],
    ['npm *>&1 run deploy', 'deploy the application to production'],
    ['npm run deploy', 'deploy the application to production'],
    ['npm\frun\fdeploy', 'deploy the application to production'],
    ['& (gcm npm) run deploy', 'deploy the application to production'],
    // A value the hook cannot read is asked about rather than assumed safe.
    ["$c = 'npm run deploy'; iex $c", 'deploy the application to production'],
    [
      "[scriptblock]::Create('npm run deploy').Invoke()",
      'deploy the application to production',
    ],
    [
      "$ExecutionContext.InvokeCommand.InvokeScript('npm run deploy')",
      'deploy the application to production',
    ],
    [
      "npm run $('deploy')",
      'run an npm script whose name the hook cannot read',
    ],
    ['npm run $script', 'run an npm script whose name the hook cannot read'],
  ])('requires confirmation through PowerShell for %s', (command, reason) => {
    expect(throughTool('PowerShell', command)).toBe(reason);
  });

  it.each([
    'npm run deploy:check',
    'npm test',
    'npm ci',
    'npm install example-package',
    'npx wrangler d1 list',
    'npx wrangler deploy --dry-run',
  ])(
    'does not prompt through PowerShell for read-only, local, or verification work: %s',
    (command) => {
      expect(throughTool('PowerShell', command)).toBeNull();
    },
  );

  // Text PowerShell only passes along is data, not a command it runs (#591's rule, #592).
  it.each([
    "git commit -m 'npm run deploy now prompts'",
    'git commit -m "npm run deploy now prompts"',
    "Write-Output 'npm run deploy'",
    "Set-Content f.md @'\nnpm run deploy\n'@",
    'Set-Content f.md @"\nnpm run deploy\n"@',
    "Set-Content f.md @'\nnpm run deploy\n'@; Write-Output 'done'",
    "iex 'npm run deploy:check'",
    'cmd /c "npm test"',
    "Start-Process npm -ArgumentList 'test'",
    'pwsh -File build.ps1',
    'pwsh -ExecutionPolicy Bypass -File build.ps1',
    '# npm run deploy',
    'npm test # then npm run deploy',
    '<# npm run deploy #> npm test',
    'Write-Output "costs $5 (npm run deploy)"',
  ])(
    'does not prompt through PowerShell for text passed as data: %s',
    (command) => {
      expect(throughTool('PowerShell', command)).toBeNull();
    },
  );

  it('passes a tool call that carries no command', () => {
    expect(
      hookConfirmationReason({
        tool_name: 'Read',
        tool_input: { file_path: 'npm run deploy' },
      }),
    ).toBeNull();
    expect(
      hookConfirmationReason({
        tool_name: 'Monitor',
        tool_input: { ws: { url: 'wss://example.com/npm-run-deploy' } },
      }),
    ).toBeNull();
    expect(hookConfirmationReason({ tool_name: 'Agent' })).toBeNull();
  });

  it('still fails on a Bash call whose command is not a string', () => {
    expect(() =>
      hookConfirmationReason({ tool_name: 'Bash', tool_input: {} }),
    ).toThrow();
  });
});
