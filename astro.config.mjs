// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://ashebrookresidents.com',
  output: 'server',
  adapter: cloudflare(),
  integrations: [react()],
  // The page Content-Security-Policy lives HERE, not in src/middleware.ts, and
  // that split is the whole point rather than an accident.
  //
  // Astro computes a HASH for every inline script it generates — island
  // hydration, the prefetch and view-transition shims — and emits a policy
  // carrying them. That is what lets `script-src` drop 'unsafe-inline'.
  // Middleware cannot produce those hashes: they are per page, computed at
  // build time, and a header written before the body exists cannot know them.
  //
  // For on-demand routes (this site is `output: 'server'`, so all of them)
  // Astro delivers this as a RESPONSE HEADER, not a <meta> element — its
  // default is `meta` only for prerendered pages. `frame-ancestors` is
  // therefore honoured here, which it would not be in a meta element.
  // `src/middleware.ts` must not overwrite that header, and no longer does.
  security: {
    csp: {
      // Everything that is neither script nor style. Kept identical to the
      // values middleware used to send, so this is a move, not a rewrite.
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' https://api.web3forms.com https://cloudflareinsights.com",
        'frame-src https://calendar.google.com https://challenges.cloudflare.com',
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: {
        // Astro's own inline scripts arrive as hashes; these are the external
        // origins it cannot know about. `static.cloudflareinsights.com` is the
        // Web Analytics beacon, which Cloudflare's edge injects into the HTML
        // AFTER Astro has rendered and hashed it — so it can only ever be
        // allowed by origin, never by hash. Dropping it here would break
        // analytics on the deployed site while looking fine locally.
        resources: [
          "'self'",
          'https://challenges.cloudflare.com',
          'https://static.cloudflareinsights.com',
        ],
        // The one inline script Astro does NOT hash for us. `is:inline` in
        // src/pages/verify-property.astro tells Astro to leave the script
        // alone, and it has to stay that way: it defines `window.onTurnstile`,
        // the global Turnstile invokes via `data-callback`, and it must exist
        // before the async widget script can fire. A processed (deferred,
        // module) script would introduce a race on the one flow a homeowner
        // cannot work around.
        //
        // A pasted hash goes stale the moment someone edits those three lines,
        // and the failure would be silent — the callback never runs, the token
        // is never captured, and verification just stops working. So
        // `test/unit/csp-inline-hashes.test.ts` recomputes it from the page
        // source and fails the build on any drift. If that test fails, put the
        // hash it prints here.
        hashes: ['sha256-79evozFHBRmQ8NRmjH98sWrMkadjlieujXgfKVvuETU='],
      },
      styleDirective: {
        // 'unsafe-inline' stays on styles deliberately. React components set
        // inline `style` attributes, and a CSP hash cannot cover a style
        // attribute — only 'unsafe-inline' or 'unsafe-hashes' can. Removing it
        // is a separate change with its own regression surface; this one is
        // about scripts, which is where 'unsafe-inline' actually costs
        // something.
        resources: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
        ],
      },
    },
  },
});
