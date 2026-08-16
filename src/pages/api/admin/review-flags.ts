import type { APIRoute } from 'astro';
import { desc, eq, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { reviewFlags, auditEvents } from '../../../server/db/audit-schema';
import {
  AuditCorrelation,
  operationKey,
  type ReviewResolutionCode,
} from '../../../server/roster/audit';

// ADR 0022 phase 3d (#220): the board's Review Flag queue — the read surface
// for every flag phase 3d's transfer-effects machinery opens, and the ONLY
// place a human resolves one.
//
// Plain Board Access, not System Administration: flag review is governance
// work (#204), not a technical compliance capability.
//
// A flag never rewrites, invalidates, or hides the action it references.
// Resolving one records that a human looked; the remedy — a re-vote, a
// corrected tally, a motion accepting the outcome — is an ordinary governance
// act taken elsewhere. `superseded` is therefore NOT offered here: it belongs
// to the automatic void/correction path, which resolves a flag whose source
// fact was itself undone, under that command's own correlation.

export const prerender = false;

/** The typed impacted reference, mirroring `audit_review_queue_v`'s CASE. */
export type ImpactedKind =
  | 'proxy'
  | 'member_attendance'
  | 'member_vote'
  | 'motion'
  | 'ballot'
  | 'board_term'
  | 'access_grant'
  | 'audit_event';

export interface ReviewFlagRow {
  id: string;
  category: string;
  status: 'open' | 'resolved';
  openedAt: number;
  resolvedAt: number | null;
  resolutionCode: string | null;
  sourceEventId: string;
  sourceEvent: {
    eventKind: string;
    family: string;
    recordedAt: number;
    actorKind: string;
    actorAccountId: string | null;
    automaticCause: string | null;
  };
  impacted: { kind: ImpactedKind; id: string } | null;
}

/** The resolution codes a HUMAN may choose. `superseded` is reserved for the
 * automatic path — see the module note above. */
const MANUAL_RESOLUTION_CODES = new Set<ReviewResolutionCode>([
  'remediated',
  'confirmed_valid',
  'no_effect',
]);

/**
 * The full-detail register: every flag, not only the open ones, so a resolved
 * flag stays visible as history rather than vanishing from the queue that
 * recorded it. Open first, then most recently opened first — the same shape
 * `/api/admin/proxies` and the other phase-3b registers use, and the reason
 * none of them needs a separate single-record read.
 *
 * A read is a read: this writes no ledger row. (The bulk roster export is the
 * one deliberate exception in this program, and it is a POST for that reason.)
 */
async function listReviewFlags(): Promise<ReviewFlagRow[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: reviewFlags.id,
      category: reviewFlags.category,
      status: reviewFlags.status,
      openedAt: reviewFlags.openedAt,
      resolvedAt: reviewFlags.resolvedAt,
      resolutionCode: reviewFlags.resolutionCode,
      sourceEventId: reviewFlags.sourceEventId,
      impactedProxyId: reviewFlags.impactedProxyId,
      impactedMemberAttendanceId: reviewFlags.impactedMemberAttendanceId,
      impactedMemberVoteId: reviewFlags.impactedMemberVoteId,
      impactedMotionId: reviewFlags.impactedMotionId,
      impactedBallotId: reviewFlags.impactedBallotId,
      impactedBoardTermId: reviewFlags.impactedBoardTermId,
      impactedAccessGrantId: reviewFlags.impactedAccessGrantId,
      impactedEventId: reviewFlags.impactedEventId,
      eventKind: auditEvents.eventKind,
      family: auditEvents.family,
      recordedAt: auditEvents.recordedAt,
      actorKind: auditEvents.actorKind,
      actorAccountId: auditEvents.actorAccountId,
      automaticCause: auditEvents.automaticCause,
    })
    .from(reviewFlags)
    .innerJoin(auditEvents, eq(auditEvents.id, reviewFlags.sourceEventId))
    .orderBy(
      sql`CASE WHEN ${reviewFlags.status} = 'open' THEN 0 ELSE 1 END`,
      desc(reviewFlags.openedAt),
    );

  return rows.map((r) => {
    // Same order as the view's CASE; the at-most-one CHECK makes the first
    // non-null the only non-null.
    const impacted: [ImpactedKind, string | null][] = [
      ['proxy', r.impactedProxyId],
      ['member_attendance', r.impactedMemberAttendanceId],
      ['member_vote', r.impactedMemberVoteId],
      ['motion', r.impactedMotionId],
      ['ballot', r.impactedBallotId],
      ['board_term', r.impactedBoardTermId],
      ['access_grant', r.impactedAccessGrantId],
      ['audit_event', r.impactedEventId],
    ];
    const hit = impacted.find(([, id]) => id !== null);
    return {
      id: r.id,
      category: r.category,
      status: r.status,
      openedAt: r.openedAt.getTime(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.getTime() : null,
      resolutionCode: r.resolutionCode,
      sourceEventId: r.sourceEventId,
      sourceEvent: {
        eventKind: r.eventKind,
        family: r.family,
        recordedAt: r.recordedAt.getTime(),
        actorKind: r.actorKind,
        actorAccountId: r.actorAccountId,
        automaticCause: r.automaticCause,
      },
      impacted: hit ? { kind: hit[0], id: hit[1]! } : null,
    };
  });
}

/**
 * Resolves one open flag in ONE batch: the status flip is the PRIMARY (its
 * `meta.changes` decides the 409 against a concurrent resolve), and the
 * account-attributed `review_flag_resolved` root is gated on the post-state
 * the flip stamped, so a lost race leaves ZERO rows anywhere — no half-closed
 * flag, no phantom review event.
 *
 * The category is deliberately NOT encoded in the event kind: it is read from
 * the flag row, which is why the review family's kinds stay uniform across all
 * four categories.
 */
async function resolveFlag(
  body: unknown,
  actorAccountId: string,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const resolutionCode = stringField(body, 'resolutionCode');
  if (resolutionCode === 'superseded')
    return new Response(
      "'superseded' is reserved for the automatic void/correction path and cannot be chosen here",
      { status: 400 },
    );
  if (!MANUAL_RESOLUTION_CODES.has(resolutionCode as ReviewResolutionCode))
    return new Response(
      "resolutionCode must be 'remediated', 'confirmed_valid', or 'no_effect'",
      { status: 400 },
    );

  const db = getDb(env);
  const [flag] = await db
    .select({ id: reviewFlags.id, status: reviewFlags.status })
    .from(reviewFlags)
    .where(eq(reviewFlags.id, id))
    .limit(1);
  if (!flag) return new Response('Review flag not found', { status: 404 });
  if (flag.status !== 'open')
    return new Response('Review flag is already resolved', { status: 409 });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE review_flags SET status = 'resolved', resolution_code = ?, resolved_at = ?
     WHERE id = ? AND status = 'open'`,
  ).bind(resolutionCode, nowMs, id);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('review-flags', 'resolve'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'review_flag_resolved',
    guard: {
      sql: `EXISTS (SELECT 1 FROM review_flags WHERE id = ? AND resolved_at = ? AND resolution_code = ?)`,
      binds: [id, nowMs, resolutionCode],
    },
    detail: {
      family: 'review',
      reviewFlagId: id,
      resolutionCode: resolutionCode as ReviewResolutionCode,
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Review flag is already resolved', { status: 409 });
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await listReviewFlags());
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
    case 'resolve':
      return resolveFlag(parsed.value, ctx.userId);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
