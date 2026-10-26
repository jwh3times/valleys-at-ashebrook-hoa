// A tenant's claim of a Tenancy invitation (ADR 0028, #294 slice 4; spec
// decision 4).
//
// Following the link proves control of the contact the board approved, so a
// claim is recorded exactly as an Automatic Person Verification is: a
// contact-proof `person_verifications` row, the Person Link, and a
// `person_verified` Identity Event, here with the `tenant_invitation` reason.
// One batch, copied from `confirmPersonVerification`: the invitation's
// consumption is the primary statement, and it re-checks the invitation, the
// Tenancy and both gates; every later write is gated on it.
//
// Every refusal is decided by one assessment, run before the batch and again
// after a batch that wrote nothing, so the answer a race gets and the one a
// plain refusal gets cannot drift apart.

import { AuditCorrelation, operationKey, type SqlGuard } from './audit';
import { hashInvitationToken } from './tenancy-invitation';
import {
  TENANT_ACCESS_ENABLED_SQL,
  tenancyCurrentOrUpcomingSql,
  tenantAccessAvailable,
} from './tenancy';

export const CLAIM_DAILY_LIMIT = 5;
const DAY_SECONDS = 86_400;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type ClaimRefusal =
  | 'gates-off'
  | 'invalid-invitation'
  | 'tenancy-ended'
  | 'linked-elsewhere'
  | 'person-linked';

export const CLAIM_REFUSAL_MESSAGES: Record<ClaimRefusal, string> = {
  'gates-off': 'Not found',
  'invalid-invitation':
    'This invitation link is not valid. It may have expired, been used, or been replaced by a newer one. Ask the owner or the board to send a new invitation.',
  'tenancy-ended': 'This tenancy has ended. Contact the owner or the board.',
  'linked-elsewhere':
    'This account belongs to someone else. Contact the board.',
  'person-linked':
    'This tenancy has already been claimed by another account. Contact the board.',
};

export type ClaimResult = { ok: true } | { ok: false; reason: ClaimRefusal };

function claimLimitKey(accountId: string): string {
  return `tenant-claim:day:${accountId}`;
}

/**
 * Counts one claim attempt against the Account's daily limit, before the
 * token is looked at, so a failed guess costs the same as a good claim.
 * False once the limit is spent.
 */
export async function spendClaimAttempt(
  env: Env,
  accountId: string,
): Promise<boolean> {
  const key = claimLimitKey(accountId);
  const count = Number((await env.KV.get(key)) ?? '0');
  if (count >= CLAIM_DAILY_LIMIT) return false;
  await env.KV.put(key, String(count + 1), { expirationTtl: DAY_SECONDS });
  return true;
}

interface Invitation {
  id: string;
  contactMethodId: string;
  channel: 'email' | 'sms';
  tenantPersonId: string;
}

type Assessment =
  | { refusal: ClaimRefusal }
  | { refusal: null; invitation: Invitation; alreadyLinked: boolean };

/** The invitation is unconsumed, unsuperseded and unexpired at `?1`. */
const LIVE_SQL = (i: string) =>
  `(${i}.consumed_at IS NULL AND ${i}.superseded_at IS NULL AND ${i}.expires_at > ?1)`;

/** Decides the claim's outcome, in the order the refusals are listed in the
 * spec's outcome table. */
async function assess(
  env: Env,
  accountId: string,
  tokenHash: string,
  nowMs: number,
  today: string,
): Promise<Assessment> {
  if (!(await tenantAccessAvailable(env))) return { refusal: 'gates-off' };
  const row = await env.DATABASE.prepare(
    `SELECT i.id, i.contact_method_id, i.channel, t.tenant_person_id,
            ${LIVE_SQL('i')} AS live,
            ${tenancyCurrentOrUpcomingSql('t', '?2')} AS current
     FROM tenancy_invitations i JOIN tenancies t ON t.id = i.tenancy_id
     WHERE i.token_hash = ?3`,
  )
    .bind(nowMs, today, tokenHash)
    .first<{
      id: string;
      contact_method_id: string;
      channel: 'email' | 'sms';
      tenant_person_id: string;
      live: number;
      current: number;
    }>();
  if (!row || row.live !== 1) return { refusal: 'invalid-invitation' };
  if (row.current !== 1) return { refusal: 'tenancy-ended' };

  const links = await env.DATABASE.prepare(
    `SELECT account_id, person_id FROM person_links
     WHERE ended_at IS NULL AND (account_id = ? OR person_id = ?)`,
  )
    .bind(accountId, row.tenant_person_id)
    .all<{ account_id: string; person_id: string }>();
  const mine = links.results.find((l) => l.account_id === accountId);
  if (mine && mine.person_id !== row.tenant_person_id)
    return { refusal: 'linked-elsewhere' };
  if (!mine && links.results.length > 0) return { refusal: 'person-linked' };

  return {
    refusal: null,
    alreadyLinked: mine !== undefined,
    invitation: {
      id: row.id,
      contactMethodId: row.contact_method_id,
      channel: row.channel,
      tenantPersonId: row.tenant_person_id,
    },
  };
}

/**
 * Claims the invitation `token` for `accountId`. An Account already linked to
 * the tenant only consumes it: the Tenancy already applies.
 */
export async function claimTenantInvitation(
  env: Env,
  accountId: string,
  token: string,
  today: string,
): Promise<ClaimResult> {
  if (!TOKEN_SHAPE.test(token))
    return { ok: false, reason: 'invalid-invitation' };
  const tokenHash = await hashInvitationToken(token, env.BETTER_AUTH_SECRET);
  const nowMs = Date.now();
  const first = await assess(env, accountId, tokenHash, nowMs, today);
  if (first.refusal !== null) return { ok: false, reason: first.refusal };
  const { invitation } = first;

  // The primary statement: the invitation lands in its consumed post-state
  // only while it, its Tenancy and both gates still hold.
  const primary = env.DATABASE.prepare(
    `UPDATE tenancy_invitations AS i
     SET consumed_at = ?1, consumed_by_account_id = ?4
     WHERE i.id = ?3 AND ${LIVE_SQL('i')}
       AND EXISTS (
         SELECT 1 FROM tenancies t
         WHERE t.id = i.tenancy_id AND ${tenancyCurrentOrUpcomingSql('t', '?2')}
       )
       AND ${TENANT_ACCESS_ENABLED_SQL}`,
  ).bind(nowMs, today, invitation.id, accountId);

  const statements: D1PreparedStatement[] = [primary];
  if (!first.alreadyLinked) {
    const primaryGuard: SqlGuard = {
      sql: `EXISTS (SELECT 1 FROM tenancy_invitations
                    WHERE id = ? AND consumed_at = ? AND consumed_by_account_id = ?)`,
      binds: [invitation.id, nowMs, accountId],
    };
    const verificationId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    const verificationGuard: SqlGuard = {
      sql: 'EXISTS (SELECT 1 FROM person_verifications WHERE id = ?)',
      binds: [verificationId],
    };
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO person_verifications (id, account_id, person_id, method,
           contact_method_id, contact_method_party_kind, reason, verified_at)
         SELECT ?, ?, ?, ?, ?, 'person', 'automatic_contact_proof', ?
         WHERE ${primaryGuard.sql}`,
      ).bind(
        verificationId,
        accountId,
        invitation.tenantPersonId,
        invitation.channel === 'email' ? 'otp_email' : 'otp_sms',
        invitation.contactMethodId,
        nowMs,
        ...primaryGuard.binds,
      ),
      // The partial unique indexes on `person_links` are the collision guard:
      // another link for this Account or this Person, made since the
      // assessment, errors the whole batch.
      env.DATABASE.prepare(
        `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
         SELECT ?, ?, ?, ?, ?
         WHERE ${primaryGuard.sql} AND ${verificationGuard.sql}`,
      ).bind(
        linkId,
        accountId,
        invitation.tenantPersonId,
        verificationId,
        nowMs,
        ...primaryGuard.binds,
        ...verificationGuard.binds,
      ),
    );
    const correlation = new AuditCorrelation(env.DATABASE, {
      operationKey: operationKey('tenant-claim', 'person_verified'),
      actorAccountId: accountId,
      nowMs,
    });
    correlation.event({
      kind: 'person_verified',
      guard: {
        sql: 'EXISTS (SELECT 1 FROM person_links WHERE id = ?)',
        binds: [linkId],
      },
      detail: {
        family: 'identity',
        reason: 'tenant_invitation',
        personVerificationId: verificationId,
        personLinkId: linkId,
        personId: invitation.tenantPersonId,
        targetAccountId: accountId,
      },
    });
    statements.push(...correlation.statements);
  }

  let consumed = false;
  try {
    const results = await env.DATABASE.batch(statements);
    consumed = results[0].meta.changes === 1;
  } catch {
    consumed = false;
  }
  if (consumed) return { ok: true };
  const again = await assess(env, accountId, tokenHash, nowMs, today);
  return { ok: false, reason: again.refusal ?? 'invalid-invitation' };
}
