import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { requestPropertyVerification } from '../../../server/verification/property';
import { verifyTurnstile } from '../../../server/authz/turnstile';
import {
  checkUserRateLimit,
  setCooldown,
} from '../../../server/verification/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const rl = await checkUserRateLimit(env, ctx.userId);
  if (!rl.ok) {
    const message =
      rl.reason === 'cooldown'
        ? 'Please wait a couple of minutes before requesting another code.'
        : "You've reached the daily limit for verification requests. Please try again tomorrow.";
    return Response.json(
      { ok: false, rateLimited: true, message },
      { status: 429 },
    );
  }

  const { address, channel, turnstileToken } = (await request.json()) as {
    address: string;
    channel: string;
    turnstileToken: string;
  };
  if (channel !== 'email' && channel !== 'sms')
    return new Response('Bad channel', { status: 400 });
  if (!(await verifyTurnstile(env, turnstileToken, request)))
    return new Response('Bad captcha', { status: 400 });

  // Throttle re-submits regardless of outcome (incl. queued/not-found).
  await setCooldown(env, ctx.userId);

  const result = await requestPropertyVerification(
    env,
    ctx.userId,
    address,
    channel,
  );
  if ('rateLimited' in result && result.rateLimited) {
    return Response.json(
      {
        ok: false,
        rateLimited: true,
        message:
          'This property has reached its daily verification limit. Please try again tomorrow.',
      },
      { status: 429 },
    );
  }
  return Response.json(result);
};
