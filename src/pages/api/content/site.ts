import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSiteSettings } from '../../../server/content/settings';

export const prerender = false;

export const GET: APIRoute = async () => {
  console.log('GET /api/content/site');
  return Response.json(await getSiteSettings(env));
};
