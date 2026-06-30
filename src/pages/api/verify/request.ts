import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { requestPropertyVerification } from '../../../server/verification/property';
import { verifyTurnstile } from '../../../server/authz/turnstile';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const { address, channel, turnstileToken } = (await request.json()) as {
    address: string;
    channel: string;
    turnstileToken: string;
  };
  if (channel !== 'email' && channel !== 'sms') return new Response('Bad channel', { status: 400 });
  if (!(await verifyTurnstile(env, turnstileToken, request))) return new Response('Bad captcha', { status: 400 });
  const result = await requestPropertyVerification(env, ctx.userId, address, channel);
  return Response.json(result);
};
