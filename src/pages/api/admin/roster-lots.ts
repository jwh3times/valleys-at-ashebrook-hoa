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
import { isoDateOrError } from '../../../lib/types';
import { properties } from '../../../server/db/schema';
import {
  AuditCorrelation,
  operationKey,
  updatedRowGuard,
  OPERATOR_OBSERVATION,
  type Evidence,
  type SqlGuard,
} from '../../../server/roster/audit';

// ADR 0022 phase 3b (#218): Lot retirement, per #205's resolution.
//
// Retirement ends the Lot's Current Ownerships as CAUSED Roster Changes in
// the same batch — a Lot ceasing to exist ends its ownerships as a matter of
// fact, not as a separate decision. It refuses, readably and again inside the
// batch, in exactly two cases: a live Board Term still names the Lot as its
// Board-Qualifying Lot (substitute or end the term first — retirement is not
// a back door around board-service consequences), and an open occasion still
// holds the Lot in a frozen eligibility snapshot (retiring it mid-election
// would strand a snapshot row against a Lot the roster says is gone). Frozen
// snapshots are never touched, so a retired Lot keeps counting in occasions
// already open when it retired.
//
// `properties.status` is dual-written to 'inactive': legacy authorization and
// the legacy denominators still key off status until the flip, and the two
// models must not diverge on which Lots are live. `retired_day`/`retired_at`
// are the new model's answer (derive.ts reads only `retired_at`).
//
// Genuine retirement is permanent; a retirement recorded in error is an
// audited correction (`correctRetirement`), which restores the Lot but NOT
// the ownerships the erroneous retirement ended — restoring one is a
// separate void-and-recreate on the Ownership itself, where the correction
// can carry its own evidence.

export const prerender = false;

const TERM_REFUSAL =
  'A current board term names this lot as its qualifying lot — substitute or end the term first';
const SNAPSHOT_REFUSAL =
  'The lot is frozen in an open occasion — close it first';

function parseEvidence(
  body: unknown,
): { ok: true; value: Evidence } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.evidence;
  if (raw === undefined || raw === null)
    return { ok: true, value: OPERATOR_OBSERVATION };
  if (typeof raw !== 'object')
    return { ok: false, error: 'evidence must be an object' };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  switch (r.kind) {
    case 'operator_observation':
      return { ok: true, value: OPERATOR_OBSERVATION };
    case 'document': {
      const documentId = str(r.documentId);
      if (!documentId)
        return {
          ok: false,
          error: 'evidence.documentId is required for evidence.kind document',
        };
      return { ok: true, value: { kind: 'document', documentId } };
    }
    case 'external': {
      const externalReference = str(r.externalReference);
      if (!externalReference)
        return {
          ok: false,
          error:
            'evidence.externalReference is required for evidence.kind external',
        };
      return { ok: true, value: { kind: 'external', externalReference } };
    }
    default:
      return { ok: false, error: 'evidence.kind is invalid' };
  }
}

/** The two retirement refusals as one reusable guard fragment, re-checked
 * inside the batch so a term created or an occasion opened after the readable
 * pre-check still stops the retirement. */
function retirementGuards(lotId: string, associationDay: string): SqlGuard {
  return {
    sql: `NOT EXISTS (
        SELECT 1 FROM board_service_terms t
        WHERE t.qualifying_lot_id = ?
          AND t.cancelled_at IS NULL AND t.voided_at IS NULL
          AND t.actual_end_day IS NULL AND ? < t.scheduled_end_day
      )
      AND NOT EXISTS (
        SELECT 1 FROM election_eligibility ee
        JOIN elections e ON e.id = ee.election_id
        WHERE ee.property_id = ? AND e.status = 'open'
      )
      AND NOT EXISTS (
        SELECT 1 FROM motion_eligibility me
        JOIN motions m ON m.id = me.motion_id
        WHERE me.property_id = ? AND m.voting_state = 'open'
      )`,
    binds: [lotId, associationDay, lotId, lotId],
  };
}

async function retireLot(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const lotId = stringField(body, 'lotId');
  if (!lotId) return new Response('lotId is required', { status: 400 });

  const db = getDb(env);
  const lotRows = await db
    .select({ id: properties.id, retiredAt: properties.retiredAt })
    .from(properties)
    .where(eq(properties.id, lotId))
    .limit(1);
  if (lotRows.length === 0)
    return new Response('Lot not found', { status: 404 });
  if (lotRows[0].retiredAt !== null)
    return new Response('Lot already retired', { status: 409 });

  let effectiveDay = associationDay;
  const effectiveDayRaw = stringField(body, 'effectiveDay');
  if (effectiveDayRaw) {
    const result = isoDateOrError(effectiveDayRaw, 'effectiveDay');
    if (!result.ok) return new Response(result.error, { status: 400 });
    effectiveDay = result.value;
  }
  if (effectiveDay > associationDay)
    return new Response('effectiveDay may not be in the future', {
      status: 400,
    });

  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  // Readable halves of the two refusals — the guard's own SQL, evaluated, so
  // the pre-check and the batch cannot drift on what blocks a retirement.
  const guards = retirementGuards(lotId, associationDay);
  const blocked = await env.DATABASE.prepare(
    `SELECT CASE WHEN ${guards.sql} THEN 0 ELSE 1 END AS n`,
  )
    .bind(...guards.binds)
    .first<{ n: number }>();
  if (blocked?.n === 1) {
    const term = await env.DATABASE.prepare(
      `SELECT 1 AS one FROM board_service_terms t
       WHERE t.qualifying_lot_id = ?
         AND t.cancelled_at IS NULL AND t.voided_at IS NULL
         AND t.actual_end_day IS NULL AND ? < t.scheduled_end_day
       LIMIT 1`,
    )
      .bind(lotId, associationDay)
      .first();
    return new Response(term ? TERM_REFUSAL : SNAPSHOT_REFUSAL, {
      status: 409,
    });
  }

  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const primary = env.DATABASE.prepare(
    `UPDATE properties SET status = 'inactive', retired_day = ?, retired_at = ?, updated_at = ?
     WHERE id = ? AND retired_at IS NULL AND (${guards.sql})`,
  ).bind(effectiveDay, nowMs, nowSeconds, lotId, ...guards.binds);
  const rootGuard = updatedRowGuard('properties', lotId, nowMs);

  // The ownerships the retirement will end, enumerated for their caused
  // events; each statement re-checks its own row inside the batch.
  const current = await env.DATABASE.prepare(
    `SELECT id, owner_party_id, start_day FROM ownerships
     WHERE lot_id = ? AND end_day IS NULL AND voided_at IS NULL`,
  )
    .bind(lotId)
    .all<{ id: string; owner_party_id: string; start_day: string | null }>();

  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-lots', 'retire'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'lot_retired',
    guard: rootGuard,
    detail: {
      family: 'roster_change',
      effective: { day: effectiveDay },
      reason: 'board_recorded',
      evidence: evidenceResult.value,
      subjects: [{ column: 'lot_id', id: lotId, role: 'primary' }],
    },
  });

  const statements = [primary];
  for (const ownership of current.results) {
    // `end_day` must exceed a non-null `start_day`; an ownership that began on
    // or after the (possibly backdated) retirement day ends the day after it
    // began — the minimal legal interval, honest that it existed.
    statements.push(
      env.DATABASE.prepare(
        `UPDATE ownerships
         SET end_day = CASE WHEN start_day IS NULL OR start_day < ? THEN ? ELSE date(start_day, '+1 day') END,
             updated_at = ?
         WHERE id = ? AND end_day IS NULL AND voided_at IS NULL AND (${rootGuard.sql})`,
      ).bind(
        effectiveDay,
        effectiveDay,
        nowMs,
        ownership.id,
        ...rootGuard.binds,
      ),
    );
    correlation.event({
      kind: 'ownership_ended',
      actor: { kind: 'automatic', cause: 'lot_retired' },
      guard: {
        sql: `EXISTS (SELECT 1 FROM ownerships WHERE id = ? AND updated_at = ? AND end_day IS NOT NULL)`,
        binds: [ownership.id, nowMs],
      },
      detail: {
        family: 'roster_change',
        effective: { day: effectiveDay },
        reason: 'lot_retired',
        evidence: OPERATOR_OBSERVATION,
        subjects: [
          { column: 'ownership_id', id: ownership.id, role: 'ended' },
          { column: 'party_id', id: ownership.owner_party_id, role: 'related' },
        ],
      },
    });
  }
  statements.push(...correlation.statements);

  const results = await env.DATABASE.batch(statements);
  if (results[0].meta.changes !== 1)
    return new Response(
      'Lot could not be retired — it may already be retired, qualify a board term, or sit in an open occasion',
      { status: 409 },
    );
  return new Response(null, { status: 204 });
}

async function correctRetirement(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const lotId = stringField(body, 'lotId');
  if (!lotId) return new Response('lotId is required', { status: 400 });

  const db = getDb(env);
  const lotRows = await db
    .select({ id: properties.id, retiredAt: properties.retiredAt })
    .from(properties)
    .where(eq(properties.id, lotId))
    .limit(1);
  if (lotRows.length === 0)
    return new Response('Lot not found', { status: 404 });
  if (lotRows[0].retiredAt === null)
    return new Response('Lot is not retired', { status: 409 });

  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const primary = env.DATABASE.prepare(
    `UPDATE properties SET status = 'active', retired_day = NULL, retired_at = NULL, updated_at = ?
     WHERE id = ? AND retired_at IS NOT NULL`,
  ).bind(nowSeconds, lotId);

  const ctx = await resolveAuthContext(locals, request, env);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-lots', 'correctRetirement'),
    actorAccountId: ctx?.userId ?? 'unknown',
    nowMs,
  });
  correlation.event({
    kind: 'lot_retirement_corrected',
    guard: {
      // `updatedRowGuard` would also demand `retired_at IS NULL` implicitly
      // via updated_at alone; state it explicitly so the marker cannot match
      // an unrelated same-second write.
      sql: `EXISTS (SELECT 1 FROM properties WHERE id = ? AND updated_at = ? AND retired_at IS NULL)`,
      binds: [lotId, nowSeconds],
    },
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: OPERATOR_OBSERVATION,
      subjects: [{ column: 'lot_id', id: lotId, role: 'primary' }],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Lot is not retired', { status: 409 });
  return new Response(null, { status: 204 });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'retire':
      return retireLot(parsed.value, locals, request, associationDateIso());
    case 'correctRetirement':
      return correctRetirement(parsed.value, locals, request);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
