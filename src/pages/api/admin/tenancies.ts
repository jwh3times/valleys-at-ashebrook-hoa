import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { associationDateIso } from '../../../lib/format';
import { tenancies } from '../../../server/db/roster-schema';
import { fetchAdminTenancies } from '../../../server/roster/reads';
import { parseEvidence } from '../../../server/roster/ownership-input';
import {
  AuditCorrelation,
  operationKey,
  updatedRowGuard,
} from '../../../server/roster/audit';

// The board's half of Tenant Access (ADR 0028, #294 slice 2): the Tenants
// panel's list, and ending or voiding a Tenancy. Requests and approval join
// this route in slice 3.
//
// End and void never check the tenant-access gates: ending access must not
// wait on a setting, so both stay live with the feature switched off.
//
// Each mutation is one batch: the primary statement, which re-checks the
// Tenancy's state in its own WHERE, then the audit correlation gated on it.

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAdminTenancies(env, associationDateIso()), {
    headers: { 'cache-control': 'no-store' },
  });
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

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  switch (stringField(parsed.value, 'action')) {
    case 'end':
      return endTenancy(parsed.value, actorAccountId, associationDateIso());
    case 'void':
      return voidTenancy(parsed.value, actorAccountId);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
