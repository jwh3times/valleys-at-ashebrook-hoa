import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { createAuth } from '../../../server/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const body = (await request.json()) as {
    userId: string;
    role: string;
    action: string;
  };
  if (body.role !== 'homeowner' && body.role !== 'board') return new Response('Bad role', { status: 400 });
  const auth = createAuth(env);
  const target = body.action === 'revoke' ? 'visitor' : body.role;
  // Caller is board (verified above); the admin plugin authorizes setRole from the board session.
  await auth.api.setRole({ body: { userId: body.userId, role: target }, headers: request.headers });
  return new Response(null, { status: 204 });
};
