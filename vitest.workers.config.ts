// Vitest configuration for Cloudflare Workers tests.
// Uses @cloudflare/vitest-pool-workers v4 API: cloudflareTest plugin + vitest defineConfig.
// (The v3 defineWorkersConfig / @cloudflare/vitest-pool-workers/config API is not available
// in the installed v0.17.x — that subpath was removed in v4.)
//
// Astro's own Vite plugins (minus its Cloudflare adapter plugin, which
// collides with cloudflareTest's own Cloudflare Vite plugin — see the
// filter below, the mirror image of the filter vitest.config.ts applies in
// the other direction) are merged in here too, so test/server files can
// import .astro pages directly and render them through the Astro Container
// API. That is what makes page-level tests like
// test/server/meeting-pages.test.ts possible: rendered inside the real
// Workers runtime, `import { env } from 'cloudflare:workers'` in a page
// resolves exactly as it does in production, against the real D1 binding.
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { getViteConfig } from 'astro/config';
import type { PluginOption } from 'vite';

export default defineConfig(async (ctx) => {
  const migrations = await readD1Migrations('./src/server/db/migrations');
  const astroConfig = await getViteConfig({})(ctx);
  const astroPlugins = ((astroConfig.plugins ?? []) as PluginOption[])
    .flat()
    .filter(Boolean)
    .filter(
      (p: any) =>
        !(
          typeof p?.name === 'string' &&
          p.name.toLowerCase().includes('cloudflare')
        ),
    );
  return {
    resolve: {
      alias: {
        // The workerd runtime forbids runtime WebAssembly.compile(), which
        // es-module-lexer's default build attempts as an optimization before
        // falling back — the fallback attempt still fires an unhandled
        // rejection even though it recovers. Force the pure-JS asm.js build
        // so the wasm path is never attempted.
        'es-module-lexer': 'es-module-lexer/js',
      },
    },
    plugins: [
      ...astroPlugins,
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
        wrangler: { configPath: './wrangler.test.toml' },
      }),
    ],
    test: {
      include: ['test/server/**/*.test.ts'],
    },
  };
});
