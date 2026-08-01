// Shared between vitest.config.ts and vitest.workers.config.ts. Both configs
// need to identify — and drop — the Cloudflare Vite plugin(s) contributed by
// Astro's own `@astrojs/cloudflare` adapter, for opposite-but-related
// reasons: vitest.config.ts strips them because they validate environments
// at startup and reject the jsdom/node envs vitest uses there; vitest.
// workers.config.ts strips them from Astro's merged plugin set because they
// collide with cloudflareTest's own copy of the (also Cloudflare-named)
// Vite plugin — both claim to own "the Cloudflare Vite plugin" and error at
// config-resolve time if both are present. One predicate, so the two
// configs cannot silently drift apart on what counts as "a Cloudflare
// plugin".
import type { PluginOption } from 'vite';

export const isCloudflarePlugin = (p: PluginOption): boolean =>
  !!p &&
  typeof p === 'object' &&
  !Array.isArray(p) &&
  'name' in p &&
  typeof p.name === 'string' &&
  p.name.toLowerCase().includes('cloudflare');
