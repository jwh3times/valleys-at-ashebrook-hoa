// defineMiddleware is an identity function at runtime; avoid the astro:middleware
// virtual module so this file can be imported in both the Astro build and the
// Cloudflare Workers-pool Vitest tests (which do not have astro:middleware available).
import type { MiddlewareHandler } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from './server/authz/context';
import { compareInShadow } from './server/authz/shadow';
import { associationDateIso } from './lib/format';
import {
  jsonContentError,
  sameOriginError,
} from './server/authz/voting-guards';
import { writeFreezeError } from './server/authz/write-freeze';
import { routedPathname } from './server/authz/request-path';
import { getSiteSettings } from './server/content/settings';
import { DEFAULT_SITE_SETTINGS } from './lib/types';

// Astro owns the Content-Security-Policy of every rendered PAGE — see the
// `security.csp` block in astro.config.mjs. It sets that policy as a response
// header (its default for on-demand routes), and only it can: the policy
// carries a hash for every inline script it generated, which middleware cannot
// compute. This file must never overwrite that header, and the guard in
// `applySecurityHeaders` is what enforces it.
//
// What is left for middleware is everything Astro did not render: API JSON,
// the 401s and 503s produced here, document downloads. Nothing in those
// executes a script, so they get the strict policy that pages cannot use.
const NON_PAGE_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// The fallback for an HTML response that somehow arrived without Astro's
// policy. Deliberately NOT the strict one above: `default-src 'none'` on a page
// is a blank screen, and a fallback that can break the site is worse than the
// gap it covers. This omits `script-src`, `style-src` and `default-src`
// entirely — a header naming any of them would block the inline scripts whose
// hashes only Astro's policy carries — so it constrains everything except
// script and style execution.
const PAGE_FALLBACK_CSP = [
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
  // Astro already set the page's policy, with its script hashes. Overwriting it
  // is the one thing that would turn dropping 'unsafe-inline' from a hardening
  // change into an outage.
  if (headers.has('Content-Security-Policy')) return;
  // Unknown content type resolves to the page fallback, not the strict policy:
  // a response that turns out to be HTML must never meet `default-src 'none'`.
  const isHtml = headers.get('content-type')?.includes('text/html') ?? true;
  headers.set(
    'Content-Security-Policy',
    isHtml ? PAGE_FALLBACK_CSP : NON_PAGE_CSP,
  );
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  // The path Astro will ROUTE to, not the one on the wire: `/api/%61dmin/roles`
  // reaches the admin handler, and a backstop that classified the raw string
  // would wave it through as an unnamed path.
  const path = routedPathname(context.url.pathname);
  // One authority for "today" per request. Computed once so a request landing
  // astride midnight cannot resolve its context against one Association Day
  // and shadow-compare against another.
  const associationDay = associationDateIso();

  if (isVotingApi(path)) {
    // Voting's request-order contract runs before session resolution: feature
    // flags, the write freeze, exact Origin, JSON media type, authentication,
    // then role. The route repeats the same checks through requireVotingApi
    // because direct handler tests and other callers do not pass through
    // middleware.
    context.locals.site = await getSiteSettings(env);
    let response: Response;
    if (
      !context.locals.site.officialMode ||
      !context.locals.site.liveVotingEnabled
    ) {
      response = new Response('Not found', { status: 404 });
    } else {
      const requestError =
        (await writeFreezeError(env, context.request)) ??
        sameOriginError(context.request) ??
        jsonContentError(context.request);
      if (requestError) {
        response = requestError;
      } else {
        const ctx = await getAuthContext(context.request, env, associationDay);
        context.locals.authContext = ctx;
        if (!ctx) {
          response = new Response('Unauthorized', { status: 401 });
        } else if (!ctx.capabilities.has('member')) {
          response = new Response('Forbidden', { status: 403 });
        } else {
          response = await next();
        }
      }
    }
    applySecurityHeaders(response.headers);
    return response;
  }

  const ctx = await getAuthContext(context.request, env, associationDay);
  context.locals.authContext = ctx;

  // ADR 0022: compute the OTHER authorization model alongside the one that
  // answered and record only the disagreements. compareInShadow is mode-aware —
  // under legacy it derives, under derived it reads the legacy roster — so it
  // never compares a context with itself. Structurally incapable of changing
  // the answer: `ctx` is already resolved and assigned above, this returns
  // void, and it swallows its own errors. Off by default; deleted in phase 4
  // (#212), not at the flip.
  if (ctx && env.CUTOVER_SHADOW === 'on') {
    await compareInShadow(env, ctx, associationDay);
  }

  // Surface site settings (incl. officialMode) to page renders. Skip the DB read
  // for most API/file routes, which do not render chrome — they get inert
  // defaults. The homeowner-write surface is the exception: the backstop below
  // gates on the real feature flags, so it needs the real settings here too.
  // The per-route guards still re-read settings themselves rather than trusting
  // this value — a deliberate double read, since a guard must not be spoofable
  // by whatever a caller managed to put on locals.
  context.locals.site =
    path.startsWith('/api') && !isMemberApi(path)
      ? { ...DEFAULT_SITE_SETTINGS }
      : await getSiteSettings(env);

  let response: Response;
  if (isAdminApi(path)) {
    // Production backstop for the whole board-only API surface. Every handler
    // under src/pages/api/admin/ also calls requireBoard itself, and that stays
    // the tested layer — the Workers pool invokes handlers directly and never
    // runs middleware. This exists so a route shipped without its guard is not
    // exposed in the meantime. Mirrors requireBoard's codes exactly: the write
    // freeze is 503 on mutating verbs only (reads stay live), anonymous is 401,
    // an authenticated non-board caller is 403.
    const frozen = await writeFreezeError(env, context.request);
    if (frozen) {
      response = frozen;
    } else if (!ctx) {
      response = new Response('Unauthorized', { status: 401 });
    } else if (!ctx.capabilities.has('board')) {
      response = new Response('Forbidden', { status: 403 });
    } else {
      response = await next();
    }
  } else if (isMemberApi(path)) {
    // Production backstop for the homeowner-write surface, mirroring the
    // admin-API backstop above and the per-route guard codes: disabled
    // surfaces are 404 (never advertise them), a frozen site is 503 on every
    // verb here, anonymous is 401, and a visitor-role caller is 403. Every
    // handler under src/pages/api/member/ also calls requireMemberApi; this
    // exists so a route shipped without its guard is not exposed in the
    // meantime.
    if (!context.locals.site.officialMode) {
      response = new Response('Not found', { status: 404 });
    } else {
      // Nested rather than another `else if` so the freeze read happens only
      // once the surface is known to exist — a mode-off site must not pay a D1
      // read to answer 404.
      const frozen = await writeFreezeError(env, context.request);
      if (frozen) {
        response = frozen;
      } else if (!ctx) {
        response = new Response('Unauthorized', { status: 401 });
      } else if (!ctx.capabilities.has('member')) {
        response = new Response('Forbidden', { status: 403 });
      } else {
        response = await next();
      }
    }
  } else if (path.startsWith('/admin') && !ctx?.capabilities.has('board')) {
    response = context.redirect('/login', 302);
  } else if (
    path.startsWith('/homeowner') &&
    (!ctx || !ctx.capabilities.has('member'))
  ) {
    response = context.redirect('/login', 302);
  } else {
    // Everything the branches above did not claim: public pages, /api/content/*,
    // /api/files/*, /api/verify/*, /api/auth/*, /api/bootstrap/board. The freeze
    // is deny-by-default, so this branch is what catches a mutating surface
    // nobody thought to name — /api/verify/* today, whatever ships next
    // otherwise. freezePolicyFor decides; the two genuine exemptions live there.
    response = (await writeFreezeError(env, context.request)) ?? (await next());
  }
  applySecurityHeaders(response.headers);
  return response;
};
