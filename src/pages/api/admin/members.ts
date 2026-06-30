import type { APIRoute } from 'astro';
import { desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { createAuth } from '../../../server/auth';
import { getDb } from '../../../server/db/client';
import { manualApprovalQueue, userPropertyLinks, users } from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const db = getDb(env);
  const recent = await db.select().from(users).where(eq(users.role, 'homeowner')).limit(50);
  const queue = await db
    .select()
    .from(manualApprovalQueue)
    .where(eq(manualApprovalQueue.status, 'pending'))
    .orderBy(desc(manualApprovalQueue.createdAt));
  return Response.json({ recent, queue });
};

export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const db = getDb(env);
  const body = (await request.json()) as {
    action: string;
    userId?: string;
    queueId?: string;
  };
  if (body.action === 'revoke') {
    await db.delete(userPropertyLinks).where(eq(userPropertyLinks.userId, body.userId as string));
    await createAuth(env).api.setRole({
      body: { userId: body.userId as string, role: 'visitor' },
      headers: request.headers,
    });
  } else if (body.action === 'approve' || body.action === 'deny') {
    await db
      .update(manualApprovalQueue)
      .set({ status: body.action === 'approve' ? 'approved' : 'denied' })
      .where(eq(manualApprovalQueue.id, body.queueId as string));
  } else {
    return new Response('Bad action', { status: 400 });
  }
  return new Response(null, { status: 204 });
};
