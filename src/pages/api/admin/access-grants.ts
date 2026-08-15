import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import {
  requireCapability,
  Forbidden,
  type AuthContext,
} from '../../../server/authz/guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { users } from '../../../server/db/auth-schema';
import {
  accessGrants,
  boardServiceTerms,
} from '../../../server/db/roster-schema';
import { associationDateIso } from '../../../lib/format';
import {
  AuditCorrelation,
  operationKey,
  insertedRowGuard,
  ALWAYS,
} from '../../../server/roster/audit';
import { fetchAccessGrantsDetail } from '../../../server/roster/reads';

// ADR 0022 phase 3b (#218): Access Grants, per #203's resolution. Board
// Access is NEVER granted implicitly — certification creates the term only,
// and a Person Link grants nothing — and never a side effect of anything;
// this route is the one writer.
//
// Authority is asymmetric by design: a Board Access holder may grant and
// revoke Board grants (their own included), while System Administration
// grants may be touched only by a System Administrator. The route therefore
// declares `board` and escalates per action. The last-System-Administrator
// invariant lives HERE and only here — a mutation-boundary guard, never part
// of evaluation (#217) — and a refused attempt on it is permanently recorded
// as a denied Access Event, the same account-attributed shape the ledger uses
// for every access denial worth keeping.

export const prerender = false;

async function requireSystemAdmin(ctx: AuthContext): Promise<Response | null> {
  try {
    requireCapability(ctx, 'systemAdmin');
  } catch (e) {
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  return null;
}

async function grantAccess(body: unknown, ctx: AuthContext): Promise<Response> {
  const accountId = stringField(body, 'accountId');
  if (!accountId) return new Response('accountId is required', { status: 400 });
  const grantType = stringField(body, 'grantType');
  if (grantType !== 'board' && grantType !== 'system_admin')
    return new Response("grantType must be 'board' or 'system_admin'", {
      status: 400,
    });
  const qualifyingBoardTermId = stringField(body, 'qualifyingBoardTermId');
  if (grantType === 'board' && !qualifyingBoardTermId)
    return new Response('qualifyingBoardTermId is required for a board grant', {
      status: 400,
    });
  if (grantType === 'system_admin' && qualifyingBoardTermId)
    return new Response(
      'A system_admin grant never carries a qualifying term',
      { status: 400 },
    );
  if (grantType === 'system_admin') {
    const denied = await requireSystemAdmin(ctx);
    if (denied) return denied;
  }

  const db = getDb(env);
  const accountRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  if (accountRows.length === 0)
    return new Response('Account not found', { status: 404 });

  // An Access Grant authorizes an Account WITH a current Person Link
  // (CONTEXT.md) — both types.
  const link = await env.DATABASE.prepare(
    `SELECT person_id FROM person_links WHERE account_id = ? AND ended_at IS NULL LIMIT 1`,
  )
    .bind(accountId)
    .first<{ person_id: string }>();
  if (!link)
    return new Response('Account has no linked Person', { status: 409 });

  const associationDay = associationDateIso();
  if (grantType === 'board') {
    const [term] = await db
      .select()
      .from(boardServiceTerms)
      .where(eq(boardServiceTerms.id, qualifyingBoardTermId))
      .limit(1);
    if (!term) return new Response('Term not found', { status: 404 });
    // The same predicate derivation re-validates on every request: a
    // current-or-scheduled, uncancelled, unvoided term (#203 — a scheduled
    // term supports Board Access; `hasCurrentBoardTerm` is the separate,
    // stricter fact).
    const supports =
      term.cancelledAt === null &&
      term.voidedAt === null &&
      associationDay < (term.actualEndDay ?? term.scheduledEndDay);
    if (!supports)
      return new Response('Term no longer supports a grant', { status: 409 });
    if (term.personId !== link.person_id)
      return new Response("Account is not linked to the term's person", {
        status: 409,
      });
  }

  const live = await env.DATABASE.prepare(
    `SELECT 1 FROM access_grants WHERE account_id = ? AND grant_type = ? AND ended_at IS NULL LIMIT 1`,
  )
    .bind(accountId, grantType)
    .first();
  if (live !== null)
    return new Response('Account already holds a live grant of this type', {
      status: 409,
    });

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const grantReason =
    grantType === 'board' ? 'board_service' : 'technical_administration';
  // Every precondition re-checked at the mutation boundary: no live same-type
  // grant, the link still current and still the term's person, the term still
  // supporting a grant.
  const termGuardSql =
    grantType === 'board'
      ? `AND EXISTS (
           SELECT 1 FROM board_service_terms t
           JOIN person_links pl ON pl.person_id = t.person_id
           WHERE t.id = ? AND pl.account_id = ? AND pl.ended_at IS NULL
             AND t.cancelled_at IS NULL AND t.voided_at IS NULL
             AND ? < COALESCE(t.actual_end_day, t.scheduled_end_day)
         )`
      : `AND EXISTS (
           SELECT 1 FROM person_links pl
           WHERE pl.account_id = ? AND pl.ended_at IS NULL
         )`;
  const termGuardBinds =
    grantType === 'board'
      ? [qualifyingBoardTermId, accountId, associationDay]
      : [accountId];
  const primary = env.DATABASE.prepare(
    `INSERT INTO access_grants (id, account_id, grant_type, qualifying_board_term_id, started_at, granted_by_account_id, grant_reason)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
         SELECT 1 FROM access_grants WHERE account_id = ? AND grant_type = ? AND ended_at IS NULL
       )
       ${termGuardSql}`,
  ).bind(
    id,
    accountId,
    grantType,
    grantType === 'board' ? qualifyingBoardTermId : null,
    nowMs,
    ctx.userId,
    grantReason,
    accountId,
    grantType,
    ...termGuardBinds,
  );

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('access-grants', 'grant'),
    actorAccountId: ctx.userId,
    nowMs,
  });
  correlation.event({
    kind: 'grant_created',
    guard: insertedRowGuard('access_grants', id),
    detail: {
      family: 'access',
      grantId: id,
      targetAccountId: accountId,
      grantType,
      requestedAction: 'grant',
      outcome: 'allowed',
      reason: grantReason,
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Grant conflicts with the current state', {
      status: 409,
    });
  return Response.json({ id }, { status: 201 });
}

/** Permanently records the refused attempt to change the last System
 * Administrator — the ledger write happens even though the mutation is
 * denied. One row per attempt; each is a real, distinct refusal. */
async function recordLastAdministratorDenial(
  ctx: AuthContext,
  grant: { id: string; accountId: string },
): Promise<void> {
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('access-grants', 'lastAdministratorDenied'),
    actorAccountId: ctx.userId,
    nowMs: Date.now(),
  });
  correlation.event({
    kind: 'last_administrator_change',
    guard: ALWAYS,
    detail: {
      family: 'access',
      grantId: grant.id,
      targetAccountId: grant.accountId,
      grantType: 'system_admin',
      requestedAction: 'last_administrator_change',
      outcome: 'denied',
      reason: 'last_system_administrator',
    },
  });
  await env.DATABASE.batch(correlation.statements);
}

async function revokeAccess(
  body: unknown,
  ctx: AuthContext,
): Promise<Response> {
  const grantId = stringField(body, 'grantId');
  if (!grantId) return new Response('grantId is required', { status: 400 });

  const db = getDb(env);
  const [grant] = await db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.id, grantId))
    .limit(1);
  if (!grant) return new Response('Grant not found', { status: 404 });
  if (grant.endedAt !== null)
    return new Response('Grant already ended', { status: 409 });

  if (grant.grantType === 'system_admin') {
    const denied = await requireSystemAdmin(ctx);
    if (denied) return denied;
    const another = await env.DATABASE.prepare(
      `SELECT 1 FROM access_grants WHERE grant_type = 'system_admin' AND ended_at IS NULL AND id <> ? LIMIT 1`,
    )
      .bind(grantId)
      .first();
    if (!another) {
      await recordLastAdministratorDenial(ctx, grant);
      return new Response('Cannot revoke the last System Administrator', {
        status: 409,
      });
    }
  }

  const nowMs = Date.now();
  // The last-System-Administrator invariant re-checked AT the boundary: two
  // concurrent revokes of the final two grants serialize, and the second
  // finds no other live grant left and refuses.
  const primary = env.DATABASE.prepare(
    `UPDATE access_grants SET ended_at = ?, ended_by_account_id = ?, end_reason = 'revoked'
     WHERE id = ? AND ended_at IS NULL
       AND (grant_type = 'board' OR EXISTS (
         SELECT 1 FROM access_grants o
         WHERE o.grant_type = 'system_admin' AND o.ended_at IS NULL AND o.id <> ?
       ))`,
  ).bind(nowMs, ctx.userId, grantId, grantId);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('access-grants', 'revoke'),
    actorAccountId: ctx.userId,
    nowMs,
  });
  correlation.event({
    kind: 'grant_revoked',
    guard: {
      sql: `EXISTS (SELECT 1 FROM access_grants WHERE id = ? AND ended_at = ?)`,
      binds: [grantId, nowMs],
    },
    detail: {
      family: 'access',
      grantId,
      targetAccountId: grant.accountId,
      grantType: grant.grantType,
      requestedAction: 'revoke',
      outcome: 'allowed',
      reason: 'revoked',
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1) {
    if (grant.grantType === 'system_admin') {
      // Lost the race to another revoke: this one is now the last.
      await recordLastAdministratorDenial(ctx, grant);
      return new Response('Cannot revoke the last System Administrator', {
        status: 409,
      });
    }
    return new Response('Grant is no longer revocable', { status: 409 });
  }
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAccessGrantsDetail(env));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'grant':
      return grantAccess(parsed.value, ctx);
    case 'revoke':
      return revokeAccess(parsed.value, ctx);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
