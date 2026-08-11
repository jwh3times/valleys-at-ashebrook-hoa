// Ambient declarations shared by BOTH TypeScript programs: the Astro/Workers app
// (tsconfig.json) and the Node-side scripts and unit tests (tsconfig.node.json).
//
// Everything here must reference Cloudflare types through `import('...')` rather
// than relying on the Workers ambient globals, because the Node-side program
// deliberately does not load @cloudflare/workers-types. Workers-only globals and
// Astro-only declarations belong in env.d.ts instead.

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
    /** Anthropic API key for the admin document assistant (Claude generation). */
    ANTHROPIC_API_KEY: string;
    /** Cloudflare AI Search (autorag) binding for document retrieval. */
    AI: import('./server/ai/search').AiBinding;
    /** Name of the AI Search instance created in the dashboard. */
    AI_SEARCH_INSTANCE: string;
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
