// Shared Person Verification / Person Link mutation machinery (#219, PLAN-3c
// D7 + the board half of D6). Every writer here builds ONE D1 batch — domain
// statements first, then the audit correlation's statements — following the
// protocol `audit.ts` documents: a lost race leaves ZERO rows anywhere.
//
// Three callers share this module: the board's manual-verification and
// unlink surfaces (`/api/admin/person-links`, `/api/admin/verification-requests`)
// and the applicant's always-available self-unlink
// (`/api/verify/unlink`). Identity stays separate from authority everywhere
// here: a link creation NEVER writes an Access Grant, and a link ending only
// ever ENDS grants the account already held — it never revokes anything on
// its own initiative beyond that.

import {
  AuditCorrelation,
  ALWAYS,
  andGuards,
  assertInBatch,
  insertedRowGuard,
  endedLinkGuard,
  type Evidence,
  type IdentityReason,
  type SqlGuard,
} from './audit';

export type PersonLinkEndReason =
  | 'self_unlink'
  | 'account_replaced'
  | 'no_longer_qualifies'
  | 'suspected_compromise'
  | 'recorded_in_error'
  | 'resident_request';

export const PERSON_LINK_END_REASONS: ReadonlySet<string> = new Set([
  'self_unlink',
  'account_replaced',
  'no_longer_qualifies',
  'suspected_compromise',
  'recorded_in_error',
  'resident_request',
]);

// ---------------------------------------------------------------------------
// Manual verification (creates a Person Link; never transfers one)
// ---------------------------------------------------------------------------

export interface ManualVerificationOptions {
  database: D1Database;
  accountId: string;
  personId: string;
  approverAccountId: string;
  reason: 'manual_board_decision' | 'migration_reverification';
  /** Required — manual verification always cites what the approver relied on. */
  evidence: Evidence;
  nowMs: number;
  operationKey: string;
  /** An extra precondition ANDed into the primary insert's WHERE, so a
   * caller (the verification-review accept action) can couple this command's
   * success to a condition on a table this module knows nothing about —
   * "the review request is still open" — inside the SAME atomic batch. */
  extraGuard?: SqlGuard;
}

export interface ManualVerificationBatch {
  verificationId: string;
  linkId: string;
  rootEventId: string;
  /** Domain statements first, then the audit correlation's. `statements[0]`
   * (the `person_verifications` insert) is the command's success marker:
   * `results[0].meta.changes === 1` decides success. */
  statements: D1PreparedStatement[];
}

/**
 * Links an EXISTING Person to an account by manual board decision — it never
 * creates a Person. Re-checks, at the mutation boundary, everything a race
 * could invalidate between a route's readable pre-checks and this batch
 * landing: the Person still exists, is still kind `person`, is still
 * unconsolidated, and neither side is already linked. A lost race leaves
 * every table exactly as it was.
 */
export function manualVerificationStatements(
  opts: ManualVerificationOptions,
): ManualVerificationBatch {
  const {
    database,
    accountId,
    personId,
    approverAccountId,
    reason,
    evidence,
    nowMs,
    operationKey,
    extraGuard,
  } = opts;
  const verificationId = crypto.randomUUID();
  const linkId = crypto.randomUUID();

  const preconditions = [
    `EXISTS (SELECT 1 FROM people WHERE party_id = ?)`,
    `NOT EXISTS (SELECT 1 FROM parties WHERE id = ? AND consolidated_into_party_id IS NOT NULL)`,
    `NOT EXISTS (SELECT 1 FROM person_links WHERE person_id = ? AND ended_at IS NULL)`,
    `NOT EXISTS (SELECT 1 FROM person_links WHERE account_id = ? AND ended_at IS NULL)`,
    ...(extraGuard ? [`(${extraGuard.sql})`] : []),
  ].join(' AND ');

  const primary = database
    .prepare(
      `INSERT INTO person_verifications (id, account_id, person_id, method, contact_method_id, contact_method_party_kind, approver_account_id, reason, verified_at)
       SELECT ?, ?, ?, 'manual', NULL, NULL, ?, ?, ?
       WHERE ${preconditions}`,
    )
    .bind(
      verificationId,
      accountId,
      personId,
      approverAccountId,
      reason,
      nowMs,
      personId,
      personId,
      personId,
      accountId,
      ...(extraGuard ? extraGuard.binds : []),
    );

  const verificationGuard = insertedRowGuard(
    'person_verifications',
    verificationId,
  );
  const link = database
    .prepare(
      `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
       SELECT ?, ?, ?, ?, ? WHERE ${verificationGuard.sql}`,
    )
    .bind(
      linkId,
      accountId,
      personId,
      verificationId,
      nowMs,
      ...verificationGuard.binds,
    );

  const correlation = new AuditCorrelation(database, {
    operationKey,
    actorAccountId: approverAccountId,
    nowMs,
  });
  const rootEventId = correlation.event({
    kind: 'person_verified',
    guard: insertedRowGuard('person_links', linkId),
    detail: {
      family: 'identity',
      reason,
      personVerificationId: verificationId,
      personLinkId: linkId,
      personId,
      targetAccountId: accountId,
      evidence,
    },
  });

  return {
    verificationId,
    linkId,
    rootEventId,
    statements: [primary, link, ...correlation.statements],
  };
}

// ---------------------------------------------------------------------------
// Ending a Person Link (board unlink or applicant self-unlink)
// ---------------------------------------------------------------------------

export interface EndLinkOptions {
  database: D1Database;
  linkId: string;
  accountId: string;
  /** Who is performing the unlink — the account itself for self-unlink, the
   * board caller for an administrator unlink. */
  actorAccountId: string;
  endReason: PersonLinkEndReason;
  nowMs: number;
  operationKey: string;
}

/**
 * Ends a Person Link AND every current Access Grant the linked account holds
 * — Board Access and System Administration alike — in one batch, so an ended
 * link never leaves a dangling live grant. Embeds the last-System-
 * Administrator refusal directly in the link-ending statement's WHERE: if
 * the account holds the sole current `system_admin` grant, the WHOLE command
 * refuses (nothing ends — not the link, not any other grant the account may
 * also hold), because reporting success while silently keeping the account's
 * System Administration a moment longer than every other consequence would
 * be a worse lie than refusing outright.
 *
 * `statements[0]` (the `person_links` UPDATE) is the command's success
 * marker: `results[0].meta.changes === 1` decides success. Reads the
 * account's current grants BEFORE building the batch only to know which
 * per-grant caused Access Events to prepare — each is independently guarded
 * on that specific grant having actually ended at `nowMs`, so a stale read
 * (a grant already ended by a concurrent, unrelated action) is harmless: its
 * guard simply fails and no phantom event is written.
 */
export async function endLinkStatements(
  opts: EndLinkOptions,
): Promise<D1PreparedStatement[]> {
  const {
    database,
    linkId,
    accountId,
    actorAccountId,
    endReason,
    nowMs,
    operationKey,
  } = opts;

  const currentGrants = await database
    .prepare(
      `SELECT id, grant_type FROM access_grants WHERE account_id = ? AND ended_at IS NULL`,
    )
    .bind(accountId)
    .all<{ id: string; grant_type: 'board' | 'system_admin' }>();

  // The last-System-Administrator guard: the account holds a live
  // system_admin grant AND no other account currently holds one.
  const lastAdminGuard = `NOT (
      EXISTS (SELECT 1 FROM access_grants WHERE account_id = ? AND grant_type = 'system_admin' AND ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM access_grants WHERE grant_type = 'system_admin' AND ended_at IS NULL AND account_id <> ?)
    )`;

  const primary = database
    .prepare(
      `UPDATE person_links
       SET ended_at = ?, ended_by_account_id = ?, end_reason = ?
       WHERE id = ? AND ended_at IS NULL AND ${lastAdminGuard}`,
    )
    .bind(nowMs, actorAccountId, endReason, linkId, accountId, accountId);

  const linkGuard = endedLinkGuard(linkId, nowMs);

  // End exactly the grants read above — never a blanket account-wide UPDATE.
  // A grant created between the read and the batch would otherwise be ended
  // with no caused Access Event, a domain consequence with no ledger row. The
  // assertion appended below makes that race lose the whole command instead:
  // if any current grant survives once the link has ended, the batch rolls
  // back and the route answers 409.
  const grantIds = (currentGrants.results ?? []).map((g) => g.id);
  const endGrants =
    grantIds.length === 0
      ? []
      : [
          database
            .prepare(
              `UPDATE access_grants
               SET ended_at = ?, ended_by_account_id = ?, end_reason = 'person_link_ended'
               WHERE account_id = ? AND ended_at IS NULL AND id IN (${grantIds.map(() => '?').join(', ')}) AND ${linkGuard.sql}`,
            )
            .bind(
              nowMs,
              actorAccountId,
              accountId,
              ...grantIds,
              ...linkGuard.binds,
            ),
        ];
  const noSurvivingGrant: SqlGuard = {
    sql: `NOT (${linkGuard.sql}) OR NOT EXISTS (SELECT 1 FROM access_grants WHERE account_id = ? AND ended_at IS NULL)`,
    binds: [...linkGuard.binds, accountId],
  };

  const correlation = new AuditCorrelation(database, {
    operationKey,
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'person_link_ended',
    guard: linkGuard,
    detail: {
      family: 'identity',
      reason: endReason,
      personLinkId: linkId,
      targetAccountId: accountId,
    },
  });
  for (const grant of currentGrants.results ?? []) {
    const grantEndedGuard: SqlGuard = {
      sql: `EXISTS (SELECT 1 FROM access_grants WHERE id = ? AND ended_at = ?)`,
      binds: [grant.id, nowMs],
    };
    correlation.event({
      kind: 'grant_revoked',
      actor: { kind: 'automatic', cause: 'person_link_ended' },
      guard: andGuards(linkGuard, grantEndedGuard),
      detail: {
        family: 'access',
        grantId: grant.id,
        targetAccountId: accountId,
        grantType: grant.grant_type,
        requestedAction: 'revoke',
        outcome: 'allowed',
        reason: 'person_link_ended',
      },
    });
  }

  return [
    primary,
    ...endGrants,
    ...correlation.statements,
    assertInBatch(database, noSurvivingGrant),
  ];
}

// ---------------------------------------------------------------------------
// The last-System-Administrator invariant, shared across every ending path
// ---------------------------------------------------------------------------

/** Read-only check mirroring `endLinkStatements`' embedded guard, used by
 * routes for a readable pre-check ahead of the batch. */
export async function wouldStripLastSystemAdministrator(
  database: D1Database,
  accountId: string,
): Promise<{ soleGrantId: string } | null> {
  const row = await database
    .prepare(
      `SELECT id FROM access_grants WHERE account_id = ? AND grant_type = 'system_admin' AND ended_at IS NULL LIMIT 1`,
    )
    .bind(accountId)
    .first<{ id: string }>();
  if (!row) return null;
  const other = await database
    .prepare(
      `SELECT 1 FROM access_grants WHERE grant_type = 'system_admin' AND ended_at IS NULL AND account_id <> ? LIMIT 1`,
    )
    .bind(accountId)
    .first();
  if (other) return null;
  return { soleGrantId: row.id };
}

/**
 * If ending this account's link would strip the last System Administrator,
 * PERMANENTLY records the refused attempt as a denied Access Event (mirroring
 * `/api/admin/access-grants`' equivalent guard) and returns true. Callers use
 * this both ahead of `endLinkStatements` (the readable-error path) and after
 * a lost `meta.changes` race (the same denial, recorded once the race is
 * confirmed) — mirroring `access-grants.ts`'s `recordLastAdministratorDenial`
 * call sites exactly.
 */
export async function denyIfLastSystemAdministrator(opts: {
  database: D1Database;
  accountId: string;
  actorAccountId: string;
  nowMs: number;
  operationKey: string;
}): Promise<boolean> {
  const sole = await wouldStripLastSystemAdministrator(
    opts.database,
    opts.accountId,
  );
  if (!sole) return false;
  const correlation = new AuditCorrelation(opts.database, {
    operationKey: opts.operationKey,
    actorAccountId: opts.actorAccountId,
    nowMs: opts.nowMs,
  });
  correlation.event({
    kind: 'last_administrator_change',
    guard: ALWAYS,
    detail: {
      family: 'access',
      grantId: sole.soleGrantId,
      targetAccountId: opts.accountId,
      grantType: 'system_admin',
      requestedAction: 'last_administrator_change',
      outcome: 'denied',
      reason: 'last_system_administrator',
    },
  });
  await opts.database.batch(correlation.statements);
  return true;
}

// Re-export the reason union for route-side validation without a second
// source of truth.
export type { IdentityReason };
