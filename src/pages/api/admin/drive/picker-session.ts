import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../../server/authz/api-guards';
import { driveConfig, notConfigured } from '../../../../server/drive/config';
import {
  googleUnavailable,
  mintAccessToken,
  noConnection,
  touchLastUsed,
} from '../../../../server/drive/connection';

export const prerender = false;

/**
 * What the board admin's browser needs to open Google Picker on the
 * association's Drive (#290 slice 3, spec decision 2): a freshly minted access
 * token (never stored), the Picker API key and the Cloud project number. The
 * token is valid for up to an hour and reaches only files the association has
 * picked (`drive.file`); the board accepted that exposure in review (Q9).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const config = driveConfig(env);
  if (!config) return notConfigured();
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  let minted;
  try {
    minted = await mintAccessToken(env, config, ctx.userId);
  } catch (err) {
    console.error('[drive] minting a Picker token failed', err);
    return googleUnavailable();
  }
  if (minted.kind !== 'minted') return noConnection();
  await touchLastUsed(env, minted.version);
  return Response.json(
    {
      accessToken: minted.accessToken,
      expiresAt: Date.now() + minted.expiresIn * 1000,
      developerKey: config.pickerApiKey,
      appId: config.projectNumber,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
};
