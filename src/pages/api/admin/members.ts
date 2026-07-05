import type { APIRoute } from 'astro';
import { and, desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import {
  manualApprovalQueue,
  properties,
  userPropertyLinks,
  users,
} from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
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

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const db = getDb(env);
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const body = (parsed.value ?? {}) as {
    action?: string;
    userId?: string;
    queueId?: string;
    propertyId?: string;
  };
  if (body.action === 'revoke') {
    if (!body.userId) return new Response('Bad Request', { status: 400 });
    const [target] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, body.userId));
    if (target?.role === 'board')
      return new Response(
        'Cannot demote a board member here; use Board members.',
        { status: 409 },
      );
    await db
      .update(users)
      .set({ role: 'visitor' })
      .where(eq(users.id, body.userId));
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
    // Don't link a user to a property that doesn't exist or is inactive.
    const [prop] = await db
      .select({ status: properties.status })
      .from(properties)
      .where(eq(properties.id, body.propertyId));
    if (!prop) return new Response('No such property', { status: 404 });
    if (prop.status !== 'active')
      return new Response('Property is inactive', { status: 409 });
    // Approving a user for a home they're already linked to is harmless
    // (the (user_id, property_id) unique would otherwise reject the insert).
    await db
      .insert(userPropertyLinks)
      .values({
        id: crypto.randomUUID(),
        userId: row.userId,
        propertyId: body.propertyId,
        verifiedAt: new Date(),
        method: 'board_manual',
      })
      .onConflictDoNothing();
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
