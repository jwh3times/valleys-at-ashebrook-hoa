import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { productionConfirmationReason } from '../../scripts/require-production-confirmation';

describe('production confirmation hook', () => {
  it('is registered without the blanket npm-run approval it guards', () => {
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
          matcher: 'Bash',
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

  it.each([
    'npm run deploy',
    'npm run db:migrate:remote',
    'npm run secrets:put -- ANTHROPIC_API_KEY',
    'npm run corpus:import -- --commit --wipe',
    'npm run docs:dedupe -- --commit',
    'npm run roster:backfill -- --remote --write --operator=operator-id',
    'npm run shadow:sweep -- --write --remote',
    'npx wrangler deploy -c dist/server/wrangler.json',
    'wrangler d1 execute DATABASE --remote --file migration.sql',
    'node --experimental-strip-types scripts/put-secret.ts EMAIL_API_KEY',
    'npm install example-package',
  ])('requires confirmation for %s', (command) => {
    expect(productionConfirmationReason(command)).not.toBeNull();
  });

  it.each([
    'npm run deploy:check',
    'npm run corpus:import',
    'npm run roster:backfill -- --remote',
    'npm run shadow:sweep -- --local --write',
    'npx wrangler d1 migrations list DATABASE --remote',
    'npm ci',
    'npm test',
  ])(
    'does not prompt for read-only, local, or verification work: %s',
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
});
