// defineMiddleware is an identity function at runtime; avoid the astro:middleware
// virtual module so this file can be imported in both the Astro build and the
// Cloudflare Workers-pool Vitest tests (which do not have astro:middleware available).
import type { MiddlewareHandler } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from './server/authz/context';
import { getSiteSettings } from './server/content/settings';
import { DEFAULT_SITE_SETTINGS } from './lib/types';

// Enumerated from the code's external dependencies plus what Cloudflare's edge
// injects: Google Fonts, the Google Calendar embed (frame), Turnstile
// (script+frame), Web3Forms (connect), and the Cloudflare Web Analytics beacon
// (static.cloudflareinsights.com script; it reports same-origin to /cdn-cgi/rum
// on the proxied domain, so 'self' covers the beacon, and cloudflareinsights.com
// is allowed for the non-proxied/edge case). Enforced (not Report-Only) after
// auditing every resource against these directives; keep 'unsafe-inline' because
// Astro injects inline styles + island hydration scripts. To temporarily revert
// if a new third-party resource is added, swap the header name back to
// `Content-Security-Policy-Report-Only` while updating the list.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://api.web3forms.com https://cloudflareinsights.com",
  'frame-src https://calendar.google.com https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * True for the board-only API surface. Matched exactly rather than by bare
 * prefix so a future sibling like /api/administrators is not silently gated
 * (and, more importantly, so nobody assumes a prefix match is enough and names
 * a public route into the trap).
 */
function isAdminApi(path: string): boolean {
  return path === '/api/admin' || path.startsWith('/api/admin/');
}

/**
 * The homeowner-write API surface. Same exact-prefix caution as isAdminApi.
 */
function isMemberApi(path: string): boolean {
  return path === '/api/member' || path.startsWith('/api/member/');
}

/**
 * The live homeowner-voting API surface. Kept separate from isMemberApi so
 * proxy routes remain available whenever official mode is on, independent of
 * the live-voting feature flag.
 */
function isVotingApi(path: string): boolean {
  return path === '/api/vote' || path.startsWith('/api/vote/');
}

function applySecurityHeaders(headers: Headers): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  headers.set('Content-Security-Policy', CSP);
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const ctx = await getAuthContext(context.request, env);
  context.locals.authContext = ctx;
  const path = context.url.pathname;

  // Surface site settings (incl. officialMode) to page renders. Skip the DB read
  // for most API/file routes, which do not render chrome — they get inert
  // defaults. The homeowner-write surface is the exception: the backstop below
  // gates on the real feature flags, so it needs the real settings here too.
  // The per-route guards still re-read settings themselves rather than trusting
  // this value — a deliberate double read, since a guard must not be spoofable
  // by whatever a caller managed to put on locals.
  context.locals.site =
    path.startsWith('/api') && !isMemberApi(path) && !isVotingApi(path)
      ? { ...DEFAULT_SITE_SETTINGS }
      : await getSiteSettings(env);

  let response: Response;
  if (isAdminApi(path)) {
    // Production backstop for the whole board-only API surface. Every handler
    // under src/pages/api/admin/ also calls requireBoard itself, and that stays
    // the tested layer — the Workers pool invokes handlers directly and never
    // runs middleware. This exists so a route shipped without its guard is not
    // exposed in the meantime. Mirrors requireBoard's codes exactly: anonymous
    // is 401, an authenticated non-board caller is 403.
    if (!ctx) {
      response = new Response('Unauthorized', { status: 401 });
    } else if (ctx.role !== 'board') {
      response = new Response('Forbidden', { status: 403 });
    } else {
      response = await next();
    }
  } else if (isMemberApi(path) || isVotingApi(path)) {
    // Production backstop for the homeowner-write and live-voting surfaces,
    // mirroring the admin-API backstop above and the per-route guard codes:
    // disabled surfaces are 404 (never advertise them), anonymous is 401, and
    // a visitor-role caller is 403. Every handler under src/pages/api/member/
    // calls requireMemberApi, while /api/vote calls requireVotingApi. Those
    // per-route calls are the enforced and tested layer (see
    // member-routes-all-gated.test.ts); this exists so a route shipped without
    // its guard is not exposed meanwhile.
    if (
      !context.locals.site.officialMode ||
      (isVotingApi(path) && !context.locals.site.liveVotingEnabled)
    ) {
      response = new Response('Not found', { status: 404 });
    } else if (!ctx) {
      response = new Response('Unauthorized', { status: 401 });
    } else if (ctx.role === 'visitor') {
      response = new Response('Forbidden', { status: 403 });
    } else {
      response = await next();
    }
  } else if (path.startsWith('/admin') && ctx?.role !== 'board') {
    response = context.redirect('/login', 302);
  } else if (
    path.startsWith('/homeowner') &&
    (!ctx || ctx.role === 'visitor')
  ) {
    response = context.redirect('/login', 302);
  } else {
    response = await next();
  }
  applySecurityHeaders(response.headers);
  return response;
};
