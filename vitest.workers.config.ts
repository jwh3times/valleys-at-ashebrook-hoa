// Vitest configuration for Cloudflare Workers tests.
// Uses @cloudflare/vitest-pool-workers' current API: cloudflareTest plugin + Vitest defineConfig.
// (The older defineWorkersConfig / @cloudflare/vitest-pool-workers/config API is not available
// in the installed v0.21.x line.)
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
import { isCloudflarePlugin } from './vitest.shared';

export default defineConfig(async (ctx) => {
  const migrations = await readD1Migrations('./src/server/db/migrations');
  const astroConfig = await getViteConfig({})(ctx);
  const allAstroPlugins = ((astroConfig.plugins ?? []) as PluginOption[])
    .flat()
    .filter(Boolean);
  const astroPlugins = allAstroPlugins.filter((p) => !isCloudflarePlugin(p));
  // If the filter above matched nothing, either Astro stopped shipping a
  // Cloudflare plugin (unlikely — the adapter is in astro.config.mjs) or
  // @cloudflare/vite-plugin / @astrojs/cloudflare renamed its plugins out
  // from under isCloudflarePlugin's "name contains 'cloudflare'" check. Fail
  // loudly here rather than letting it surface later as the much more
  // opaque "environment options are incompatible with the Cloudflare Vite
  // plugin" config-resolve error this filter exists to prevent.
  if (astroPlugins.length === allAstroPlugins.length) {
    throw new Error(
      'Cloudflare plugin filter matched 0 plugins — @cloudflare/vite-plugin or ' +
        '@astrojs/cloudflare likely renamed its plugins; see the comment above',
    );
  }
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
        // Pool 0.21 builds the test Worker from Miniflare's config-based
        // WorkerOptions. These supported overrides merge over wrangler.test.toml;
        // the Astro plugin graph and es-module-lexer alias above remain unchanged.
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
