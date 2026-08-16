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
     * First-System-Administrator bootstrap secret (see /api/bootstrap/board).
     * Optional: set only around the one-time bootstrap, and safe to unset
     * afterward — the endpoint self-disables once the
     * `system_admin_bootstrap` singleton is consumed. The legacy
     * BOARD_EMAIL/BOARD_PASSWORD/BOARD_NAME sign-up vars were retired with
     * the phase 3c rewrite (#219).
     */
    BOOTSTRAP_SECRET?: string;
    /**
     * ADR 0022 phase 2 shadow comparison: set to `"on"` to compute the derived
     * authorization context alongside the legacy one and record only the
     * disagreements. Absent or anything else means off.
     *
     * Declared here rather than in wrangler.toml deliberately, twice over. The
     * generated types narrow a committed var to its literal value, so a
     * committed `"off"` makes `=== 'on'` a type error describing the file
     * rather than the runtime. And this is an operator switch for one phase,
     * not deployment configuration — the cutover flag itself stays a D1
     * singleton, because that one must flip in seconds without a deploy.
     * Removed at the phase-3 flip.
     */
    CUTOVER_SHADOW?: string;
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
