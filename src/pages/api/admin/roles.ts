import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { users } from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const board = await getDb(env)
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.role, 'board'));
  return Response.json({ board });
};

// Board handoff is a deliberate, supported workflow: an outgoing board member
// promotes the incoming one, then the incoming one demotes the outgoing one.
// Role changes are direct DB writes (getAuthContext re-reads role every request,
// so they take effect immediately) — no dependency on the Better Auth admin API.
export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    email?: string;
    userId?: string;
  } | null;
  if (!body) return new Response('Bad Request', { status: 400 });
  const db = getDb(env);

  if (body.action === 'promote') {
    const email = body.email?.trim();
    if (!email) return new Response('Email required', { status: 400 });
    const [target] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));
    if (!target)
      return new Response('No account with that email', { status: 404 });
    await db
      .update(users)
      .set({ role: 'board' })
      .where(eq(users.id, target.id));
    return new Response(null, { status: 204 });
  }

  if (body.action === 'demote') {
    if (!body.userId) return new Response('userId required', { status: 400 });
    const board = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'board'));
    if (board.length <= 1)
      return new Response('Cannot demote the last board member', {
        status: 409,
      });
    await db
      .update(users)
      .set({ role: 'visitor' })
      .where(and(eq(users.id, body.userId), eq(users.role, 'board')));
    return new Response(null, { status: 204 });
  }

  return new Response('Bad action', { status: 400 });
};
