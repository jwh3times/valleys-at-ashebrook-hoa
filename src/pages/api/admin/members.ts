import type { APIRoute } from 'astro';
import { and, desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { getCutoverMode } from '../../../server/authz/cutover-mode';
import { readJson } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import {
  manualApprovalQueue,
  properties,
  userPropertyLinks,
  users,
} from '../../../server/db/schema';
import {
  endedLinkGuard,
  isBatchAssertionError,
  operationKey,
} from '../../../server/roster/audit';
import {
  currentPersonLinkFor,
  liveGrantIdsFor,
} from '../../../server/roster/access';
import {
  denyIfLastSystemAdministrator,
  endLinkStatements,
} from '../../../server/roster/identity';

export const prerender = false;

const BOARD_MEMBER_REFUSAL =
  'Cannot demote a board member here; use Board members.';

/**
 * ADR 0022 phase 3e (#221): revocation, in whichever model is authoritative.
 *
 * Under `derived` the thing being revoked is not a stored role at all — it is
 * the account's Person Link, and with it every Access Grant that link
 * supports. The shared identity machinery ends both in one batch (carrying
 * the last-System-Administrator refusal with it), and the legacy role and
 * property links ride along as WRITE-BEHIND MIRRORS in that same batch, never
 * read as authorization facts.
 */
async function revokeDerived(
  accountId: string,
  actorAccountId: string,
): Promise<Response> {
  // The same refusal as the legacy branch's, asked of the model that answers:
  // board access is ended on the board handoff surface, not here.
  const boardGrants = await liveGrantIdsFor(env.DATABASE, accountId, 'board');
  if (boardGrants.length > 0)
    return new Response(BOARD_MEMBER_REFUSAL, { status: 409 });

  const link = await currentPersonLinkFor(env.DATABASE, accountId);
  if (!link)
    return new Response(
      'This account is not linked to a person in the roster — there is nothing to revoke.',
      { status: 409 },
    );

  const nowMs = Date.now();
  if (
    await denyIfLastSystemAdministrator({
      database: env.DATABASE,
      accountId,
      actorAccountId,
      nowMs,
      operationKey: operationKey('members', 'lastAdministratorDenied'),
    })
  )
    return new Response('Cannot revoke the last System Administrator', {
      status: 409,
    });

  // A board revocation says the account should no longer act for its lots —
  // `no_longer_qualifies` is that statement; `self_unlink` is the applicant's
  // own reason and is never available here.
  const statements = await endLinkStatements({
    database: env.DATABASE,
    linkId: link.id,
    accountId,
    actorAccountId,
    endReason: 'no_longer_qualifies',
    nowMs,
    operationKey: operationKey('members', 'revoke'),
  });
  const ended = endedLinkGuard(link.id, nowMs);
  const mirrorRole = env.DATABASE.prepare(
    `UPDATE users SET role = 'visitor', updated_at = ?
     WHERE id = ? AND ${ended.sql}`,
  ).bind(nowMs, accountId, ...ended.binds);
  const mirrorLinks = env.DATABASE.prepare(
    `DELETE FROM user_property_links WHERE user_id = ? AND ${ended.sql}`,
  ).bind(accountId, ...ended.binds);

  let results: D1Result[];
  try {
    results = await env.DATABASE.batch([
      ...statements,
      mirrorRole,
      mirrorLinks,
    ]);
  } catch (error) {
    if (isBatchAssertionError(error))
      return new Response('Access changed concurrently — try again', {
        status: 409,
      });
    throw error;
  }
  if (results[0].meta.changes !== 1) {
    if (
      await denyIfLastSystemAdministrator({
        database: env.DATABASE,
        accountId,
        actorAccountId,
        nowMs: Date.now(),
        operationKey: operationKey('members', 'lastAdministratorDenied'),
      })
    )
      return new Response('Cannot revoke the last System Administrator', {
        status: 409,
      });
    return new Response('Revocation conflicts with the current state', {
      status: 409,
    });
  }
  return new Response(null, { status: 204 });
}

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
    if ((await getCutoverMode(env)) === 'derived') {
      // The board-member refusal is decided inside revokeDerived from live
      // Access Grants — never from the users.role mirror, which this mode
      // only writes.
      const ctx = await resolveAuthContext(locals, request, env);
      if (!ctx) return new Response('Unauthorized', { status: 401 });
      return revokeDerived(body.userId, ctx.userId);
    }
    // Legacy branch: users.role IS the authoritative store here, so reading
    // it to refuse is the pre-3e behavior, kept bit-for-bit.
    const [target] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, body.userId));
    if (target?.role === 'board')
      return new Response(BOARD_MEMBER_REFUSAL, { status: 409 });
    await db
      .update(users)
      .set({ role: 'visitor' })
      .where(eq(users.id, body.userId));
    await db
      .delete(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, body.userId));
    // `approve` and `deny` are deliberately NOT mode-branched. They act on
    // the old manual approval queue, which has been write-dead since v0.10.0
    // — nothing enqueues to it in either mode — so the only rows they can
    // ever reach are pre-v0.10.0 leftovers, and stranding those would be the
    // one real cost of re-pointing them. The verification-review queue that
    // replaced it is a separate surface.
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
