/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    DATABASE: import('@cloudflare/workers-types').D1Database;
    KV: import('@cloudflare/workers-types').KVNamespace;
    DOCS: import('@cloudflare/workers-types').R2Bucket;
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    EMAIL_API_KEY: string;
    EMAIL_FROM: string;
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_FROM: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY: string;
    WEB3FORMS_KEY?: string;
    /**
     * First-board bootstrap secrets (see /api/bootstrap/board). Optional: set
     * only during the one-time bootstrap, and safe to unset afterward — the
     * endpoint self-disables once a board account exists.
     */
    BOOTSTRAP_SECRET?: string;
    BOARD_EMAIL?: string;
    BOARD_PASSWORD?: string;
    BOARD_NAME?: string;
    /** Test-only binding: D1 migrations applied via applyD1Migrations in Workers tests. */
    MIGRATIONS?: import('@cloudflare/vitest-pool-workers').D1Migration[];
  }
}

interface Env extends Cloudflare.Env {}

interface Window {
  onTurnstile?: (token: string) => void;
  turnstileToken?: string;
  turnstile?: { reset: () => void };
}

type Runtime = import('@astrojs/cloudflare').Runtime;
declare namespace App {
  interface Locals extends Runtime {
    authContext: import('./server/authz/guards').AuthContext | null;
    site: import('./lib/types').SiteSettings;
  }
}
