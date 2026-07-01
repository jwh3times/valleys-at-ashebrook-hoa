// Vitest configuration for Cloudflare Workers tests.
// Uses @cloudflare/vitest-pool-workers v4 API: cloudflareTest plugin + vitest defineConfig.
// (The v3 defineWorkersConfig / @cloudflare/vitest-pool-workers/config API is not available
// in the installed v0.17.x — that subpath was removed in v4.)
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./src/server/db/migrations');
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          compatibilityDate: '2026-06-01',
          d1Databases: ['DATABASE'],
          kvNamespaces: ['KV'],
          r2Buckets: ['DOCS'],
          bindings: {
            MIGRATIONS: migrations,
            BETTER_AUTH_SECRET: 'test-secret-not-real',
            BETTER_AUTH_URL: 'http://localhost',
            EMAIL_API_KEY: 'test',
            EMAIL_FROM: 'test@example.com',
            TWILIO_ACCOUNT_SID: 'AC_test',
            TWILIO_AUTH_TOKEN: 'test',
            TWILIO_FROM: '+10000000000',
            TURNSTILE_SECRET_KEY: 'test',
          },
        },
        wrangler: { configPath: './wrangler.toml' },
      }),
    ],
    test: {
      include: ['test/server/**/*.test.ts'],
    },
  };
});
