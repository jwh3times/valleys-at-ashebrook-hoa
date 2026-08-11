/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Astro/Workers-only declarations. The Workers ambient globals pulled in by the
// reference above apply to THIS program only (tsconfig.json) — the Node-side
// program (tsconfig.node.json) excludes this file on purpose, so that
// @cloudflare/workers-types cannot shadow Node's own globals in scripts and unit
// tests. Declarations both programs need live in ambient.d.ts.

type Runtime = import('@astrojs/cloudflare').Runtime;
declare namespace App {
  interface Locals extends Runtime {
    authContext: import('./server/authz/guards').AuthContext | null;
    site: import('./lib/types').SiteSettings;
  }
}
