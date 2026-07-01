// defineMiddleware is an identity function at runtime; avoid the astro:middleware
// virtual module so this file can be imported in both the Astro build and the
// Cloudflare Workers-pool Vitest tests (which do not have astro:middleware available).
import type { MiddlewareHandler } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from './server/authz/context';

export const onRequest: MiddlewareHandler = async (context, next) => {
  const ctx = await getAuthContext(context.request, env);
  context.locals.authContext = ctx;
  const path = context.url.pathname;
  if (path.startsWith('/admin') && ctx?.role !== 'board') {
    return context.redirect('/login', 302);
  }
  if (path.startsWith('/homeowner') && (!ctx || ctx.role === 'visitor')) {
    return context.redirect('/login', 302);
  }
  return next();
};
