import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createAuth } from '../../../server/auth';

export const prerender = false;

export const ALL: APIRoute = ({ request }) => {
  const auth = createAuth(env, undefined, env.BETTER_AUTH_URL);
  return auth.handler(request);
};
