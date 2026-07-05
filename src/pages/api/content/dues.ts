import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDuesSettings } from '../../../server/content/settings';

export const prerender = false;

export const GET: APIRoute = async () =>
  Response.json(await getDuesSettings(env));
