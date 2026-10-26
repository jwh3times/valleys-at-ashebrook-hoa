import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { boardAccessSql } from '../../../server/authz/derive';
import { associationDateIso } from '../../../lib/format';
import { tenancies } from '../../../server/db/roster-schema';
import {
  fetchAdminTenancies,
  fetchAdminTenancyRequests,
} from '../../../server/roster/reads';
import { parseEvidence } from '../../../server/roster/ownership-input';
import {
  APPROVAL_REFUSAL_MESSAGES,
  approveTenancyRequest,
} from '../../../server/roster/tenancy-approval';
import {
  AuditCorrelation,
  operationKey,
  updatedRowGuard,
} from '../../../server/roster/audit';
import {
  CLEAR_REQUEST_CONTACT_SQL,
  tenantAccessAvailable,
} from '../../../server/roster/tenancy';
import {
  approvalInvitation,
  inviteTenant,
  reinviteResponse,
} from '../../../server/roster/tenancy-invitation';

// The board's half of Tenant Access (ADR 0028, #294): the Tenants panel's
// list, approving or refusing an owner's request (slice 3), ending or voiding
// a Tenancy (slice 2), and re-inviting a tenant who has not claimed (slice 4).
//
// Approve and reinvite answer 404 while either gate is off, and re-check both
// inside their writes. Approval sends the tenant's invitation once its batch
// has landed; a failed send leaves the approval standing, and the panel
// offers a re-invite. Refuse, end and void never check the gates, so all three stay live
// with the feature switched off: ending access must not wait on a setting, and
// a pending request's name and contact can always be cleared (review decision,
// 2026-10-25). The list says whether approval is open, so the panel can offer
// only Refuse while it is not.
//
// Each mutation is one batch: the primary statement, which re-checks the
// Tenancy's state in its own WHERE, then the audit correlation gated on it.

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const today = associationDateIso();
  const [tenancyRows, requests, approvalOpen] = await Promise.all([
    fetchAdminTenancies(env, today),
    fetchAdminTenancyRequests(env, today),
    tenantAccessAvailable(env),
  ]);
  return Response.json(
    { tenancies: tenancyRows, requests, approvalOpen },
    { headers: { 'cache-control': 'no-store' } },
  );
};

async function existingTenancy(id: string) {
  const [row] = await getDb(env)
    .select()
    .from(tenancies)
    .where(eq(tenancies.id, id))
    .limit(1);
  return row;
}

/** Ends a current or upcoming Tenancy today. One that has not begun ends on
 * its start day, so it never runs. */
async function endTenancy(
  body: unknown,
  actorAccountId: string,
  today: string,
): Promise<Response> {
  const tenancyId = stringField(body, 'tenancyId');
  if (!tenancyId) return new Response('tenancyId is required', { status: 400 });
  const evidence = parseEvidence(body);
  if (!evidence.ok) return new Response(evidence.error, { status: 400 });
  const existing = await existingTenancy(tenancyId);
  if (!existing) return new Response('Tenancy not found', { status: 404 });
  if (existing.voidedAt !== null)
    return new Response('Tenancy was voided', { status: 409 });
  if (existing.actualEndDay !== null)
    return new Response('Tenancy already ended', { status: 409 });
  if (existing.scheduledEndDay <= today)
    return new Response('Tenancy has already reached its end day', {
      status: 409,
    });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE tenancies
     SET actual_end_day = MAX(start_day, ?), end_reason = 'board_ended',
         ended_by_account_id = ?, updated_at = ?
     WHERE id = ? AND voided_at IS NULL AND actual_end_day IS NULL
       AND MAX(start_day, ?) < scheduled_end_day`,
  ).bind(today, actorAccountId, nowMs, tenancyId, today);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('tenancies', 'end'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'tenancy_ended',
    guard: updatedRowGuard('tenancies', tenancyId, nowMs),
    detail: {
      family: 'roster_change',
      effective: { day: today },
      reason: 'board_ended',
      evidence: evidence.value,
      subjects: [
        { column: 'tenancy_id', id: tenancyId, role: 'ended' },
        { column: 'lot_id', id: existing.lotId, role: 'related' },
        { column: 'party_id', id: existing.tenantPersonId, role: 'related' },
      ],
    },
  });
  const [result] = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (result.meta.changes !== 1)
    return new Response('Tenancy already ended or voided', { status: 409 });
  return new Response(null, { status: 204 });
}

/** Voids a Tenancy recorded in error. An ended one may still be voided. */
async function voidTenancy(
  body: unknown,
  actorAccountId: string,
): Promise<Response> {
  const tenancyId = stringField(body, 'tenancyId');
  if (!tenancyId) return new Response('tenancyId is required', { status: 400 });
  const evidence = parseEvidence(body);
  if (!evidence.ok) return new Response(evidence.error, { status: 400 });
  const existing = await existingTenancy(tenancyId);
  if (!existing) return new Response('Tenancy not found', { status: 404 });
  if (existing.voidedAt !== null)
    return new Response('Tenancy already voided', { status: 409 });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE tenancies SET voided_at = ?, updated_at = ?
     WHERE id = ? AND voided_at IS NULL`,
  ).bind(nowMs, nowMs, tenancyId);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('tenancies', 'void'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'tenancy_voided',
    guard: updatedRowGuard('tenancies', tenancyId, nowMs),
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: evidence.value,
      subjects: [
        { column: 'tenancy_id', id: tenancyId, role: 'voided' },
        { column: 'lot_id', id: existing.lotId, role: 'related' },
      ],
    },
  });
  const [result] = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (result.meta.changes !== 1)
    return new Response('Tenancy already voided', { status: 409 });
  return new Response(null, { status: 204 });
}

const REFUSAL_REASON_MAX = 500;

/** Records the Tenancy an owner asked for; see `tenancy-approval.ts`. */
async function approveRequest(
  body: unknown,
  actorAccountId: string,
  today: string,
): Promise<Response> {
  const requestId = stringField(body, 'requestId');
  if (!requestId) return new Response('requestId is required', { status: 400 });
  const personId = stringField(body, 'personId') || null;
  const result = await approveTenancyRequest({
    database: env.DATABASE,
    requestId,
    personId,
    actorAccountId,
    today,
  });
  if (result.ok) {
    const invitation = approvalInvitation(
      await inviteTenant(env, {
        tenancyId: result.tenancyId,
        contactMethodId: result.contactMethodId,
        today,
        // A credential is a grant: the board's access is re-checked in the
        // write, as approval's own batch re-checked it.
        scope: boardAccessSql(actorAccountId, today),
      }),
    );
    return Response.json(
      { tenancyId: result.tenancyId, personId: result.personId, invitation },
      { status: 201 },
    );
  }
  if (result.status === 409)
    return Response.json(
      {
        reason: result.reason,
        message: APPROVAL_REFUSAL_MESSAGES[result.reason],
      },
      { status: 409 },
    );
  return new Response(result.message, { status: result.status });
}

/** Refuses an open request with a reason the owner sees, clearing the
 * tenant's name and contact. No ledger row: a request is not a roster fact.
 * The UPDATE re-checks Board Access, as approval does. */
async function refuseRequest(
  body: unknown,
  actorAccountId: string,
  today: string,
): Promise<Response> {
  const requestId = stringField(body, 'requestId');
  if (!requestId) return new Response('requestId is required', { status: 400 });
  const reason = stringField(body, 'reason');
  if (!reason) return new Response('reason is required', { status: 400 });
  if (reason.length > REFUSAL_REASON_MAX)
    return new Response(
      `reason must be ${REFUSAL_REASON_MAX} characters or fewer`,
      { status: 400 },
    );
  const board = boardAccessSql(actorAccountId, today);
  const result = await env.DATABASE.prepare(
    `UPDATE tenancy_requests
     SET status = 'refused', refusal_reason = ?, decided_at = ?,
         decided_by_account_id = ?, ${CLEAR_REQUEST_CONTACT_SQL}
     WHERE id = ? AND status = 'open' AND ${board.sql}`,
  )
    .bind(reason, Date.now(), actorAccountId, requestId, ...board.binds)
    .run();
  if (result.meta.changes === 1) return new Response(null, { status: 204 });
  const row = await env.DATABASE.prepare(
    'SELECT status FROM tenancy_requests WHERE id = ?',
  )
    .bind(requestId)
    .first<{ status: string }>();
  if (!row) return new Response('Request not found', { status: 404 });
  return new Response(
    row.status === 'open'
      ? 'You no longer have board access'
      : 'This request has already been decided',
    { status: 409 },
  );
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  switch (stringField(parsed.value, 'action')) {
    case 'approve':
      if (!(await tenantAccessAvailable(env)))
        return new Response('Not found', { status: 404 });
      return approveRequest(parsed.value, actorAccountId, associationDateIso());
    case 'reinvite': {
      if (!(await tenantAccessAvailable(env)))
        return new Response('Not found', { status: 404 });
      const tenancyId = stringField(parsed.value, 'tenancyId');
      if (!tenancyId)
        return new Response('tenancyId is required', { status: 400 });
      return reinviteResponse(
        await inviteTenant(env, {
          tenancyId,
          contactMethodId: null,
          today: associationDateIso(),
          scope: boardAccessSql(actorAccountId, associationDateIso()),
        }),
      );
    }
    case 'refuse':
      return refuseRequest(parsed.value, actorAccountId, associationDateIso());
    case 'end':
      return endTenancy(parsed.value, actorAccountId, associationDateIso());
    case 'void':
      return voidTenancy(parsed.value, actorAccountId);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
