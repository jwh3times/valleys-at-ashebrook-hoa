/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    DATABASE: import('@cloudflare/workers-types').D1Database;
    KV: import('@cloudflare/workers-types').KVNamespace;
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    EMAIL_API_KEY: string;
    EMAIL_FROM: string;
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_FROM: string;
    TURNSTILE_SECRET_KEY: string;
    /** Test-only binding: D1 migrations applied via applyD1Migrations in Workers tests. */
    MIGRATIONS?: import('@cloudflare/vitest-pool-workers').D1Migration[];
  }
}

interface Env extends Cloudflare.Env {}

type Runtime = import('@astrojs/cloudflare').Runtime;
declare namespace App {
  interface Locals extends Runtime {}
}
