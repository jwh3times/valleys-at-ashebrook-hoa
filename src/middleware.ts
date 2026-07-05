// defineMiddleware is an identity function at runtime; avoid the astro:middleware
// virtual module so this file can be imported in both the Astro build and the
// Cloudflare Workers-pool Vitest tests (which do not have astro:middleware available).
import type { MiddlewareHandler } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from './server/authz/context';
import { getSiteSettings } from './server/content/settings';
import { DEFAULT_SITE_SETTINGS } from './lib/types';

// Enumerated from the code's external dependencies: Google Fonts, the Google
// Calendar embed (frame), Turnstile (script+frame), Web3Forms (connect). Enforced
// (not Report-Only) after auditing every resource against these directives; keep
// 'unsafe-inline' because Astro injects inline styles + island hydration scripts.
// To temporarily revert if a new third-party resource is added, swap the header
// name back to `Content-Security-Policy-Report-Only` while updating the list.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://api.web3forms.com",
  'frame-src https://calendar.google.com https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

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

  // Surface site settings (incl. officialMode) to page renders. Skip the DB read for
  // API/file routes, which do not render chrome — they get inert defaults.
  context.locals.site = path.startsWith('/api')
    ? { ...DEFAULT_SITE_SETTINGS }
    : await getSiteSettings(env);

  let response: Response;
  if (path.startsWith('/admin') && ctx?.role !== 'board') {
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
