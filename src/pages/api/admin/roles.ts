import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { getCutoverMode } from '../../../server/authz/cutover-mode';
import { getDb } from '../../../server/db/client';
import { users } from '../../../server/db/schema';
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
  mirrorRoleAfterBoardEnd,
} from '../../../server/roster/access';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
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
// Role changes take effect immediately — the caller is re-resolved every
// request (getAuthContext) — with no dependency on the Better Auth admin API.
//
// ADR 0022 phase 3e (#221): this route now BRANCHES on the cutover mode, the
// `/api/verify/*` precedent. Under `legacy` it writes the stored role exactly
// as it always has. Under `derived` it writes what authorization actually
// reads — an Access Grant validated against the account's Person Link and its
// qualifying Board Term, or the ending of that grant — and carries the stored
// role along as a WRITE-BEHIND MIRROR inside the same batch, so the legacy
// read model stays coherent through the flip. The mirror is written, never
// read as an authorization fact. Both branches, and the column, go in phase 4.

interface RolesBody {
  action?: string;
  email?: string;
  userId?: string;
}

/** Today's behavior, unchanged. */
async function promoteLegacy(accountId: string): Promise<Response> {
  await getDb(env)
    .update(users)
    .set({ role: 'board' })
    .where(eq(users.id, accountId));
  return new Response(null, { status: 204 });
}

/**
 * Today's contract, bit-for-bit, with the count-then-update race closed.
 *
 * The pre-check reproduces the historical answers exactly — including the
 * edge where the board is down to one member and the target is not a board
 * member at all, which has always refused rather than no-op — and the
 * "another board member remains" test is ALSO inside the update's WHERE, so
 * two concurrent demotions of the final two board members serialize and the
 * loser refuses instead of emptying the board.
 *
 * A zero-row result is disambiguated afterwards rather than assumed to be the
 * refusal: with two or more board members, demoting an account that is not
 * (or is no longer) a board member has always answered 204, and a read taken
 * after a write that did not happen cannot reintroduce the race.
 */
async function demoteLegacy(accountId: string): Promise<Response> {
  const board = await getDb(env)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'board'));
  if (board.length <= 1)
    return new Response('Cannot demote the last board member', {
      status: 409,
    });
  const result = await env.DATABASE.prepare(
    `UPDATE users SET role = 'visitor'
     WHERE id = ? AND role = 'board'
       AND (SELECT COUNT(*) FROM users WHERE role = 'board') > 1`,
  )
    .bind(accountId)
    .run();
  if (result.meta.changes !== 1) {
    const [stillBoard] = await getDb(env)
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, accountId), eq(users.role, 'board')));
    if (stillBoard)
      return new Response('Cannot demote the last board member', {
        status: 409,
      });
  }
  return new Response(null, { status: 204 });
}

/**
 * Grants Board Access in the model authorization reads, after walking the
 * chain the grant depends on. Each missing link answers with the fact that is
 * missing and where it is recorded — a promotion that quietly did nothing is
 * the failure this whole re-point exists to prevent.
 */
async function promoteDerived(
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
  const mirrorRole = env.DATABASE.prepare(
    `UPDATE users SET role = 'board', updated_at = ?
     WHERE id = ? AND ${batch.granted.sql}`,
  ).bind(nowMs, accountId, ...batch.granted.binds);

  const results = await env.DATABASE.batch([...batch.statements, mirrorRole]);
  if (results[0].meta.changes !== 1)
    return new Response('Promotion conflicts with the current state', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

/**
 * Ends the account's Board Access and mirrors the role it derives to
 * afterwards — `homeowner` while the linked person still holds Lot Authority,
 * `visitor` otherwise. Demotion must stop board access without silently
 * stripping member access, so the mirror is derived, never a flat `visitor`.
 */
async function demoteDerived(
  accountId: string,
  actorAccountId: string,
): Promise<Response> {
  const grantIds = await liveGrantIdsFor(env.DATABASE, accountId, 'board');
  if (grantIds.length === 0)
    return new Response(
      'This account holds no Board Access to revoke — board service is recorded on the Board panel and access on the Access panel.',
      { status: 409 },
    );

  // Read before the batch: afterwards the grant is gone, and the mirror must
  // describe what the account derives to WITHOUT it.
  const mirrored = await mirrorRoleAfterBoardEnd(
    env,
    accountId,
    associationDateIso(),
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
  const mirrorRole = env.DATABASE.prepare(
    `UPDATE users SET role = ?, updated_at = ?
     WHERE id = ? AND ${ending.ended.sql}`,
  ).bind(mirrored, nowMs, accountId, ...ending.ended.binds);

  let results: D1Result[];
  try {
    results = await env.DATABASE.batch([...ending.statements, mirrorRole]);
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
  const mode = await getCutoverMode(env);
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
    if (mode === 'legacy') return promoteLegacy(target.id);
    const ctx = await resolveAuthContext(locals, request, env);
    if (!ctx) return new Response('Unauthorized', { status: 401 });
    return promoteDerived(target.id, ctx.userId);
  }

  if (body.action === 'demote') {
    if (!body.userId) return new Response('userId required', { status: 400 });
    if (mode === 'legacy') return demoteLegacy(body.userId);
    const ctx = await resolveAuthContext(locals, request, env);
    if (!ctx) return new Response('Unauthorized', { status: 401 });
    return demoteDerived(body.userId, ctx.userId);
  }

  return new Response('Bad action', { status: 400 });
};
