import type { APIRoute } from 'astro';
import { and, desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { createAuth } from '../../../server/auth';
import { getDb } from '../../../server/db/client';
import {
  manualApprovalQueue,
  userPropertyLinks,
  users,
} from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const db = getDb(env);
  const recent = await db
    .select()
    .from(users)
    .where(eq(users.role, 'homeowner'))
    .orderBy(desc(users.createdAt))
    .limit(50);
  const queue = await db
    .select({
      id: manualApprovalQueue.id,
      userId: manualApprovalQueue.userId,
      email: users.email,
      claimedAddress: manualApprovalQueue.claimedAddress,
      reason: manualApprovalQueue.reason,
      status: manualApprovalQueue.status,
      createdAt: manualApprovalQueue.createdAt,
    })
    .from(manualApprovalQueue)
    .leftJoin(users, eq(manualApprovalQueue.userId, users.id))
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
    propertyId?: string;
  };
  if (body.action === 'revoke') {
    if (!body.userId) return new Response('Bad Request', { status: 400 });
    await createAuth(env).api.setRole({
      body: { userId: body.userId, role: 'visitor' },
      headers: request.headers,
    });
    await db
      .delete(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, body.userId));
  } else if (body.action === 'approve') {
    if (!body.queueId || !body.propertyId)
      return new Response('Bad Request', { status: 400 });
    const [row] = await db
      .select()
      .from(manualApprovalQueue)
      .where(eq(manualApprovalQueue.id, body.queueId));
    if (!row) return new Response('Not Found', { status: 404 });
    await db.insert(userPropertyLinks).values({
      id: crypto.randomUUID(),
      userId: row.userId,
      propertyId: body.propertyId,
      verifiedAt: new Date(),
      method: 'board_manual',
    });
    await db
      .update(users)
      .set({ role: 'homeowner' })
      .where(and(eq(users.id, row.userId), eq(users.role, 'visitor')));
    await db
      .update(manualApprovalQueue)
      .set({ status: 'approved' })
      .where(eq(manualApprovalQueue.id, body.queueId));
  } else if (body.action === 'deny') {
    if (!body.queueId) return new Response('Bad Request', { status: 400 });
    await db
      .update(manualApprovalQueue)
      .set({ status: 'denied' })
      .where(eq(manualApprovalQueue.id, body.queueId));
  } else {
    return new Response('Bad action', { status: 400 });
  }
  return new Response(null, { status: 204 });
};
