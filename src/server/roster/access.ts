// Shared Access Grant machinery (#218's register, #221's re-pointed handoff).
//
// Two surfaces now create and end Board Access: `/api/admin/access-grants`,
// the explicit register decided by #203, and the board-handoff route
// `/api/admin/roles`, whose `derived` branch must produce EXACTLY the same
// rows — the same guarded insert, the same ledger correlation, the same
// mutation-boundary re-checks. A second hand-written copy of that insert is
// how the two would drift, and a handoff that wrote a subtly different grant
// (a missing qualifying term, an unrecorded consequence) is precisely the
// failure the register exists to prevent. So the builder lives here and both
// routes call it.
//
// Every builder here follows `audit.ts`'s protocol: domain statements first,
// then the correlation's, every statement guarded so a lost race leaves ZERO
// rows anywhere and the route decides the 409 from `meta.changes` on
// `statements[0]`.

import {
  AuditCorrelation,
  assertInBatch,
  insertedRowGuard,
  type SqlGuard,
} from './audit';
import { deriveAccess } from '../authz/derive';

export type GrantType = 'board' | 'system_admin';

export interface GrantStatementOptions {
  database: D1Database;
  accountId: string;
  grantType: GrantType;
  /** Required for a `board` grant, always null for `system_admin`. */
  qualifyingBoardTermId: string | null;
  associationDay: string;
  actorAccountId: string;
  nowMs: number;
  operationKey: string;
}

export interface GrantStatementBatch {
  grantId: string;
  /** `statements[0]` is the command's success marker. */
  statements: D1PreparedStatement[];
  /** Marker proving THIS command's grant landed, for a caller appending
   * write-behind mirrors to the same batch. */
  granted: SqlGuard;
}

/**
 * Creates one Access Grant, re-checking every precondition AT the mutation
 * boundary: no live same-type grant for the account, a current Person Link,
 * and — for a Board grant — that the link still points at the term's Person
 * and the term is still uncancelled, unvoided, and not yet ended (#203: a
 * *scheduled* term supports Board Access; being *current* is the separate,
 * stricter fact).
 */
export function grantStatements(
  opts: GrantStatementOptions,
): GrantStatementBatch {
  const {
    database,
    accountId,
    grantType,
    qualifyingBoardTermId,
    associationDay,
    actorAccountId,
    nowMs,
    operationKey,
  } = opts;
  const id = crypto.randomUUID();
  const grantReason =
    grantType === 'board' ? 'board_service' : 'technical_administration';
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

  const primary = database
    .prepare(
      `INSERT INTO access_grants (id, account_id, grant_type, qualifying_board_term_id, started_at, granted_by_account_id, grant_reason)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
         SELECT 1 FROM access_grants WHERE account_id = ? AND grant_type = ? AND ended_at IS NULL
       )
       ${termGuardSql}`,
    )
    .bind(
      id,
      accountId,
      grantType,
      grantType === 'board' ? qualifyingBoardTermId : null,
      nowMs,
      actorAccountId,
      grantReason,
      accountId,
      grantType,
      ...termGuardBinds,
    );

  const granted = insertedRowGuard('access_grants', id);
  const correlation = new AuditCorrelation(database, {
    operationKey,
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'grant_created',
    guard: granted,
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

  return {
    grantId: id,
    statements: [primary, ...correlation.statements],
    granted,
  };
}

export interface EndBoardGrantsOptions {
  database: D1Database;
  accountId: string;
  /** Exactly the live Board grants read ahead of the batch. */
  grantIds: string[];
  actorAccountId: string;
  nowMs: number;
  operationKey: string;
}

export interface EndBoardGrantsBatch {
  /** `statements[0]` is the command's success marker: zero changes means the
   * last-board refusal (or a lost race), never a partial write. */
  statements: D1PreparedStatement[];
  /** Marker proving this command ended the account's Board Access. */
  ended: SqlGuard;
}

/**
 * Ends every live Board grant an account holds, refusing at the mutation
 * boundary if that would leave NO account holding Board Access.
 *
 * That refusal is the derived model's form of the legacy "cannot demote the
 * last board member" rule, and it lives in the statement's own WHERE rather
 * than in a preceding count, so two concurrent demotions of the final two
 * board members serialize and the second finds no other holder and refuses.
 * It counts *accounts with a live Board grant*, exactly as the legacy branch
 * counts accounts with the stored role; whether each grant's qualifying term
 * still validates is evaluation's question, not this boundary's.
 *
 * Like `endLinkStatements`, it ends exactly the grants read beforehand and
 * asserts afterwards that none survives, so a grant created concurrently
 * loses the whole command instead of being ended with no caused Access Event.
 */
export function endBoardGrantsStatements(
  opts: EndBoardGrantsOptions,
): EndBoardGrantsBatch {
  const { database, accountId, grantIds, actorAccountId, nowMs, operationKey } =
    opts;

  const primary = database
    .prepare(
      `UPDATE access_grants
       SET ended_at = ?, ended_by_account_id = ?, end_reason = 'revoked'
       WHERE account_id = ? AND grant_type = 'board' AND ended_at IS NULL
         AND id IN (${grantIds.map(() => '?').join(', ')})
         AND EXISTS (
           SELECT 1 FROM access_grants o
           WHERE o.grant_type = 'board' AND o.ended_at IS NULL AND o.account_id <> ?
         )`,
    )
    .bind(nowMs, actorAccountId, accountId, ...grantIds, accountId);

  const ended: SqlGuard = {
    sql: `EXISTS (SELECT 1 FROM access_grants WHERE account_id = ? AND grant_type = 'board' AND ended_at = ?)`,
    binds: [accountId, nowMs],
  };

  const correlation = new AuditCorrelation(database, {
    operationKey,
    actorAccountId,
    nowMs,
  });
  // One event per grant ended. The register admits at most one live grant per
  // account per type, so this is a list of one in practice; writing it as a
  // list keeps the ledger honest if that ever stops being true.
  for (const grantId of grantIds) {
    correlation.event({
      kind: 'grant_revoked',
      guard: {
        sql: `EXISTS (SELECT 1 FROM access_grants WHERE id = ? AND ended_at = ?)`,
        binds: [grantId, nowMs],
      },
      detail: {
        family: 'access',
        grantId,
        targetAccountId: accountId,
        grantType: 'board',
        requestedAction: 'revoke',
        outcome: 'allowed',
        reason: 'revoked',
      },
    });
  }

  const noSurvivingGrant: SqlGuard = {
    sql: `NOT (${ended.sql}) OR NOT EXISTS (SELECT 1 FROM access_grants WHERE account_id = ? AND grant_type = 'board' AND ended_at IS NULL)`,
    binds: [...ended.binds, accountId],
  };

  return {
    statements: [
      primary,
      ...correlation.statements,
      assertInBatch(database, noSurvivingGrant),
    ],
    ended,
  };
}

/** The account's current Person Link, or null. */
export async function currentPersonLinkFor(
  database: D1Database,
  accountId: string,
): Promise<{ id: string; personId: string } | null> {
  const row = await database
    .prepare(
      `SELECT id, person_id AS personId FROM person_links
       WHERE account_id = ? AND ended_at IS NULL LIMIT 1`,
    )
    .bind(accountId)
    .first<{ id: string; personId: string }>();
  return row ?? null;
}

/**
 * A Board Term of this Person's that could support a grant today — the same
 * current-or-scheduled predicate `grantStatements` re-checks at the boundary.
 * The latest-starting one wins when several qualify, which is the term a
 * board handoff means.
 */
export async function grantableBoardTermFor(
  database: D1Database,
  personId: string,
  associationDay: string,
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT id FROM board_service_terms
       WHERE person_id = ? AND cancelled_at IS NULL AND voided_at IS NULL
         AND ? < COALESCE(actual_end_day, scheduled_end_day)
       ORDER BY start_day DESC LIMIT 1`,
    )
    .bind(personId, associationDay)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Ids of the account's live grants of one type. */
export async function liveGrantIdsFor(
  database: D1Database,
  accountId: string,
  grantType: GrantType,
): Promise<string[]> {
  const rows = await database
    .prepare(
      `SELECT id FROM access_grants
       WHERE account_id = ? AND grant_type = ? AND ended_at IS NULL`,
    )
    .bind(accountId, grantType)
    .all<{ id: string }>();
  return (rows.results ?? []).map((r) => r.id);
}

/**
 * The `users.role` a WRITE-BEHIND MIRROR should carry for an account once its
 * Board Access has ended — never read as an authorization fact, kept only so
 * the legacy read model stays coherent through the flip.
 *
 * Derived from the same `deriveAccess` the real model uses rather than from a
 * second hand-written query: `homeowner` exactly when the linked Person still
 * holds Lot Authority (a current Ownership, or a Representation over a lot
 * the represented Organization currently owns), else `visitor`. A live System
 * Administration grant still confers board capability, so it still mirrors as
 * `board` — ending someone's Board Access must not present them as demoted
 * from an administration they still hold.
 */
export async function mirrorRoleAfterBoardEnd(
  env: Env,
  accountId: string,
  associationDay: string,
): Promise<'board' | 'homeowner' | 'visitor'> {
  const derived = await deriveAccess(env, accountId, associationDay);
  if (derived.capabilities.has('systemAdmin')) return 'board';
  return derived.lotIds.length > 0 ? 'homeowner' : 'visitor';
}
