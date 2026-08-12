// Ambient declarations shared by BOTH TypeScript programs: the Astro/Workers app
// (tsconfig.json) and the Node-side scripts and unit tests (tsconfig.node.json).
//
// Worker runtime types and configured bindings are generated into
// worker-configuration.d.ts. This file augments that generated Env with secrets
// managed outside wrangler.toml and the Workers-test migration binding.

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    EMAIL_API_KEY: string;
    EMAIL_FROM: string;
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_FROM: string;
    TURNSTILE_SECRET_KEY: string;
    /** Anthropic API key for the admin document assistant (Claude generation). */
    ANTHROPIC_API_KEY: string;
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
