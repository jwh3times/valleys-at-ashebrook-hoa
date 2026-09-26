import type { APIRoute } from 'astro';
import { eq, isNull } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { users } from '../../../server/db/schema';
import { accessGrants } from '../../../server/db/roster-schema';
import { associationDateIso } from '../../../lib/format';
import {
  isBatchAssertionError,
  operationKey,
} from '../../../server/roster/audit';
import {
  currentPersonLinkFor,
  endBoardGrantsStatements,
  grantStatements,
  grantableBoardTermFor,
  liveGrantIdsFor,
} from '../../../server/roster/access';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const board = await getDb(env)
    .selectDistinct({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(accessGrants, eq(accessGrants.accountId, users.id))
    .where(isNull(accessGrants.endedAt));
  return Response.json({ board });
};

// Board handoff is a deliberate, supported workflow: an outgoing board member
// promotes the incoming one, then the incoming one demotes the outgoing one.
// Role changes take effect immediately — the caller is re-resolved every
// request (getAuthContext) — with no dependency on the Better Auth admin API.
//
interface RolesBody {
  action?: string;
  email?: string;
  userId?: string;
}

/**
 * Grants Board Access in the model authorization reads, after walking the
 * chain the grant depends on. Each missing link answers with the fact that is
 * missing and where it is recorded — a promotion that quietly did nothing is
 * the failure this whole re-point exists to prevent.
 */
async function promote(
  accountId: string,
  actorAccountId: string,
): Promise<Response> {
  const associationDay = associationDateIso();
  const link = await currentPersonLinkFor(env.DATABASE, accountId);
  if (!link)
    return new Response(
      'This account is not linked to a person in the roster — verify the account, or link it on the Access panel, before granting Board Access.',
      { status: 409 },
    );

  const termId = await grantableBoardTermFor(
    env.DATABASE,
    link.personId,
    associationDay,
  );
  if (!termId)
    return new Response(
      'The linked person holds no current or scheduled Board Term — record the term on the Board panel before granting Board Access.',
      { status: 409 },
    );

  const live = await liveGrantIdsFor(env.DATABASE, accountId, 'board');
  if (live.length > 0)
    return new Response('This account already holds Board Access', {
      status: 409,
    });

  const nowMs = Date.now();
  const batch = grantStatements({
    database: env.DATABASE,
    accountId,
    grantType: 'board',
    qualifyingBoardTermId: termId,
    associationDay,
    actorAccountId,
    nowMs,
    operationKey: operationKey('roles', 'promote'),
  });

  const results = await env.DATABASE.batch(batch.statements);
  if (results[0].meta.changes !== 1)
    return new Response('Promotion conflicts with the current state', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

/** Ends Board Access; current Lot Authority independently preserves member access. */
async function demote(
  accountId: string,
  actorAccountId: string,
): Promise<Response> {
  const grantIds = await liveGrantIdsFor(env.DATABASE, accountId, 'board');
  if (grantIds.length === 0)
    return new Response(
      'This account holds no Board Access to revoke — board service is recorded on the Board panel and access on the Access panel.',
      { status: 409 },
    );

  const nowMs = Date.now();
  const ending = endBoardGrantsStatements({
    database: env.DATABASE,
    accountId,
    grantIds,
    actorAccountId,
    nowMs,
    operationKey: operationKey('roles', 'demote'),
  });

  let results: D1Result[];
  try {
    results = await env.DATABASE.batch(ending.statements);
  } catch (error) {
    // Access granted concurrently with this demotion would otherwise survive
    // it; the batch assertion makes that race lose the whole command.
    if (isBatchAssertionError(error))
      return new Response('Access changed concurrently — try again', {
        status: 409,
      });
    throw error;
  }
  if (results[0].meta.changes < 1)
    return new Response('Cannot demote the last board member', { status: 409 });
  return new Response(null, { status: 204 });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as RolesBody | null;
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
    const ctx = await resolveAuthContext(locals, request, env);
    if (!ctx) return new Response('Unauthorized', { status: 401 });
    return promote(target.id, ctx.userId);
  }

  if (body.action === 'demote') {
    if (!body.userId) return new Response('userId required', { status: 400 });
    const ctx = await resolveAuthContext(locals, request, env);
    if (!ctx) return new Response('Unauthorized', { status: 401 });
    return demote(body.userId, ctx.userId);
  }

  return new Response('Bad action', { status: 400 });
};
