import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../server/authz/api-guards';

export const prerender = false;

// The caller's own access, as the model that serves them derives it (#212).
//
// The admin UI decides whether to show the board panels from this, not from
// the Better Auth session's `role`: that column is only the write-behind
// mirror of an Access Grant, and a UI keyed to it can disagree with the gate
// every admin route actually applies. The route gates stay the authority —
// this only keeps the screen honest about what they will allow.
//
// It answers about the caller alone, so it is no oracle about anyone else,
// and it names capabilities, never the Lots or Person behind them.
export const GET: APIRoute = async ({ request, locals }) => {
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  return Response.json(
    {
      capabilities: [...ctx.capabilities].sort(),
      contentTier: ctx.contentTier,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
};
