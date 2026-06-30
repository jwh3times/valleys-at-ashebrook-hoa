/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';
import type { ConfigEnv, PluginOption } from 'vite';

// Reuse Astro's Vite config so tests can import .astro files and TSX/JSX with
// the same resolution as the app. We must strip the Cloudflare vite plugins —
// they validate environments at startup and reject the jsdom/node envs that
// vitest uses, causing a hard failure before any tests run.
const baseConfig = getViteConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx,astro}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**'],
    },
  },
});

const isCloudflare = (p: PluginOption): boolean =>
  !!p &&
  typeof p === 'object' &&
  !Array.isArray(p) &&
  'name' in p &&
  typeof p.name === 'string' &&
  p.name.toLowerCase().includes('cloudflare');

export default async (ctx: ConfigEnv) => {
  const config = await baseConfig(ctx);
  // Strip Cloudflare plugins — incompatible with vitest jsdom/node environments.
  config.plugins = ((config.plugins ?? []) as PluginOption[])
    .flat()
    .filter((p) => !isCloudflare(p));
  return config;
};
