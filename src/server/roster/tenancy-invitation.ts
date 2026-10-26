// The invitation an approved tenant follows to claim their Tenancy (ADR 0028,
// #294 slice 4; spec decision 4).
//
// An invitation is a link carrying a 256-bit random token, not a 6-digit code:
// it is sent before the tenant has an Account and must last days in an inbox,
// so nothing binds it to an Account the way a code is bound. Only the token's
// HMAC under BETTER_AUTH_SECRET is stored, with the codes' hash.
//
// It is sent only to a contact the board approved: the request's contact on
// approval, and on a re-invite or a renewal, the contact of the tenant's
// latest invitation for that Lot. A new invitation supersedes the Tenancy's
// earlier unconsumed ones only once it has been sent, so a failed send never
// kills a link the tenant already holds. Sends are limited to three a day per
// Tenancy, in KV, like the verification sends.

import { OFFICIAL_ORG_NAME } from '../../lib/site';
import { sendEmail, sendSms } from '../auth/senders';
import { hashCode } from '../verification/codes';
import type { SqlGuard } from './audit';
import { TENANT_ACCESS_ENABLED_SQL, tenancyCurrentSql } from './tenancy';

export const INVITATION_TTL_MS = 14 * 86_400_000;
export const INVITATION_DAILY_LIMIT = 3;
const DAY_SECONDS = 86_400;

/** 32 random bytes, base64url without padding: 43 characters. */
export function generateInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function hashInvitationToken(
  token: string,
  secret: string,
): Promise<string> {
  return hashCode(token, secret);
}

/** Why a Tenancy cannot be invited now; each is a 409. */
export type InviteRefusal =
  'gates-off' | 'tenancy-ended' | 'already-claimed' | 'no-contact';

export const INVITE_REFUSAL_MESSAGES: Record<InviteRefusal, string> = {
  'gates-off': 'Tenant access is switched off.',
  'tenancy-ended': 'This Tenancy has ended or was voided.',
  'already-claimed': 'The tenant has already claimed access.',
  'no-contact':
    'The contact the board approved is no longer on file. Contact the board.',
};

export type InviteResult =
  | { kind: 'sent' }
  | { kind: 'not_found' }
  | { kind: 'refused'; reason: InviteRefusal }
  | { kind: 'rate_limited' }
  | { kind: 'send_failed' };

interface Check {
  reason: InviteRefusal;
  sql: string;
}

/** Every condition for inviting, each a predicate over the Tenancy `t`, the
 * Contact Method `c` and the day `d.today`, in the order a refusal names
 * them. */
const CHECKS: Check[] = [
  { reason: 'gates-off', sql: TENANT_ACCESS_ENABLED_SQL },
  {
    reason: 'tenancy-ended',
    sql: `(${tenancyCurrentSql('t', 'd.today')}
      OR (t.start_day > d.today AND ${tenancyCurrentSql('t', 't.start_day')}))`,
  },
  {
    reason: 'already-claimed',
    sql: `NOT EXISTS (
      SELECT 1 FROM person_links pl
      WHERE pl.person_id = t.tenant_person_id AND pl.ended_at IS NULL
    )`,
  },
  {
    reason: 'no-contact',
    sql: `(c.id IS NOT NULL AND c.party_id = t.tenant_person_id
      AND c.party_kind = 'person'
      AND c.value IS NOT NULL AND c.voided_at IS NULL AND c.redacted_at IS NULL
      AND (c.start_day IS NULL OR c.start_day <= d.today)
      AND (c.end_day IS NULL OR d.today < c.end_day))`,
  },
];

/** The Tenancy `t`, the contact `c` (bound by id, possibly none) and today. */
const SOURCE = `tenancies t
  CROSS JOIN (SELECT ? AS today) d
  LEFT JOIN contact_methods c ON c.id = ?`;

const ALL_CHECKS = CHECKS.map((c) => `(${c.sql})`).join(' AND ');

/** The contact of the tenant's latest invitation for the Tenancy's Lot. */
async function latestInvitationContact(
  database: D1Database,
  tenancyId: string,
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT i.contact_method_id AS id
       FROM tenancies t
       JOIN tenancies t2
         ON t2.tenant_person_id = t.tenant_person_id AND t2.lot_id = t.lot_id
       JOIN tenancy_invitations i ON i.tenancy_id = t2.id
       WHERE t.id = ?
       ORDER BY i.created_at DESC, i.id DESC LIMIT 1`,
    )
    .bind(tenancyId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

interface Invitable {
  channel: 'email' | 'sms' | null;
  value: string | null;
  /** The first condition that fails, or null when the Tenancy may be invited. */
  refusal: InviteRefusal | null;
}

/** The contact to send to, and the first failing check; null when no such
 * Tenancy exists. */
async function readInvitable(
  database: D1Database,
  tenancyId: string,
  contactMethodId: string | null,
  today: string,
): Promise<Invitable | null> {
  return database
    .prepare(
      `SELECT c.channel, c.value, CASE
         ${CHECKS.map((c) => `WHEN NOT (${c.sql}) THEN '${c.reason}'`).join('\n         ')}
         ELSE NULL END AS refusal
       FROM ${SOURCE} WHERE t.id = ?`,
    )
    .bind(today, contactMethodId, tenancyId)
    .first<Invitable>();
}

function sendLimitKey(tenancyId: string): string {
  return `tenant-invite:day:${tenancyId}`;
}

async function sendsToday(env: Env, tenancyId: string): Promise<number> {
  return Number((await env.KV.get(sendLimitKey(tenancyId))) ?? '0');
}

function invitationMessage(link: string): { subject: string; text: string } {
  return {
    subject: `Your tenant access invitation — ${OFFICIAL_ORG_NAME}`,
    text: `The ${OFFICIAL_ORG_NAME} board has approved tenant access for you. Open this link within 14 days and sign in or create an account to claim it:\n\n${link}\n\nIf you weren't expecting this, you can ignore this message.`,
  };
}

export interface InviteInput {
  tenancyId: string;
  /** The approved contact; null reuses the tenant's latest invitation's. */
  contactMethodId: string | null;
  today: string;
  /** The caller's own condition over the Tenancy `t`, re-checked inside the
   * insert: an owner's Lot Authority. A failure there answers
   * `tenancy-ended`'s 409 unless another check names the cause. */
  scope?: SqlGuard;
}

/**
 * Issues and sends a fresh invitation for a current or upcoming, unclaimed
 * Tenancy, while both gates are on. The insert re-checks every condition, so
 * a race answers the same refusal.
 */
export async function inviteTenant(
  env: Env,
  input: InviteInput,
): Promise<InviteResult> {
  const database = env.DATABASE;
  const contactMethodId =
    input.contactMethodId ??
    (await latestInvitationContact(database, input.tenancyId));

  const found = await readInvitable(
    database,
    input.tenancyId,
    contactMethodId,
    input.today,
  );
  if (!found) return { kind: 'not_found' };
  if (found.refusal) return { kind: 'refused', reason: found.refusal };
  if ((await sendsToday(env, input.tenancyId)) >= INVITATION_DAILY_LIMIT)
    return { kind: 'rate_limited' };

  const origin = env.BETTER_AUTH_URL?.replace(/\/+$/, '');
  if (!origin) return { kind: 'send_failed' };

  const token = generateInvitationToken();
  const id = crypto.randomUUID();
  const nowMs = Date.now();
  // A one-statement batch, like the other tenant writes, so a test can pause
  // it and race it.
  const tokenHash = await hashInvitationToken(token, env.BETTER_AUTH_SECRET);
  const [inserted] = await database.batch([
    database
      .prepare(
        `INSERT INTO tenancy_invitations (id, tenancy_id, contact_method_id,
         channel, token_hash, expires_at, created_at)
       SELECT ?, t.id, c.id, c.channel, ?, ?, ?
       FROM ${SOURCE} WHERE t.id = ? AND ${ALL_CHECKS}
         AND ${input.scope?.sql ?? '1'}`,
      )
      .bind(
        id,
        tokenHash,
        nowMs + INVITATION_TTL_MS,
        nowMs,
        input.today,
        contactMethodId,
        input.tenancyId,
        ...(input.scope?.binds ?? []),
      ),
  ]);
  if (inserted.meta.changes !== 1) {
    const again = await readInvitable(
      database,
      input.tenancyId,
      contactMethodId,
      input.today,
    );
    return { kind: 'refused', reason: again?.refusal ?? 'tenancy-ended' };
  }

  const link = `${origin}/tenant-invite?token=${token}`;
  const message = invitationMessage(link);
  try {
    if (found.channel === 'email')
      await sendEmail(env, found.value!, message.subject, message.text);
    else await sendSms(env, found.value!, message.text);
  } catch {
    // Nobody holds this token, so the row would only mislead.
    await database
      .prepare(`DELETE FROM tenancy_invitations WHERE id = ?`)
      .bind(id)
      .run();
    return { kind: 'send_failed' };
  }

  await database
    .prepare(
      `UPDATE tenancy_invitations SET superseded_at = ?
       WHERE tenancy_id = ? AND id <> ? AND created_at <= ?
         AND consumed_at IS NULL AND superseded_at IS NULL`,
    )
    .bind(nowMs, input.tenancyId, id, nowMs)
    .run();
  await env.KV.put(
    sendLimitKey(input.tenancyId),
    String((await sendsToday(env, input.tenancyId)) + 1),
    { expirationTtl: DAY_SECONDS },
  );
  return { kind: 'sent' };
}

/** A re-invite's answer: 204 when sent, the masked 404, 409 with the reason,
 * 429 over the daily limit, 502 when the provider failed. */
export function reinviteResponse(result: InviteResult): Response {
  switch (result.kind) {
    case 'sent':
      return new Response(null, { status: 204 });
    case 'not_found':
      return new Response('Not found', { status: 404 });
    case 'refused':
      return Response.json(
        {
          reason: result.reason,
          message: INVITE_REFUSAL_MESSAGES[result.reason],
        },
        { status: 409 },
      );
    case 'rate_limited':
      return new Response(
        `At most ${INVITATION_DAILY_LIMIT} invitations a day can be sent for one Tenancy`,
        { status: 429 },
      );
    case 'send_failed':
      return new Response('The invitation could not be sent; try again', {
        status: 502,
      });
  }
}

/** What approval tells the panel about the invitation. A refusal means
 * there was nothing to send: a renewal for a tenant who has claimed. */
export type ApprovalInvitation =
  'sent' | 'send_failed' | 'rate_limited' | 'none';

export function approvalInvitation(result: InviteResult): ApprovalInvitation {
  switch (result.kind) {
    case 'sent':
    case 'send_failed':
    case 'rate_limited':
      return result.kind;
    default:
      return 'none';
  }
}
