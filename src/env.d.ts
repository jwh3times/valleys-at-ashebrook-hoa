/// <reference path="../.astro/types.d.ts" />

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
}

// @astrojs/cloudflare v14 Runtime is { cfContext: ExecutionContext } — no
// generic Env parameter. Augmenting App.Locals here is consistent with the
// adapter's own types.d.ts declaration and explicit for future readers.
type CloudflareRuntime = import('@astrojs/cloudflare').Runtime;

declare namespace App {
  interface Locals extends CloudflareRuntime {}
}
