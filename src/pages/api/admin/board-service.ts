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
import { properties, elections } from '../../../server/db/schema';
import {
  people,
  boardServiceTerms,
  boardOfficeAssignments,
} from '../../../server/db/roster-schema';
import {
  AuditCorrelation,
  operationKey,
  updatedRowGuard,
  insertedRowGuard,
  OPERATOR_OBSERVATION,
  type BoardServiceReason,
  type Evidence,
  type ScalarDelta,
  type SqlGuard,
} from '../../../server/roster/audit';
import {
  qualifiesGuard,
  noOverlapGuard,
} from '../../../server/roster/board-consequences';
import { fetchBoardService, OFFICES } from '../../../server/roster/reads';

// ADR 0022 phase 3b (#218): the Board service lifecycle, per #203's
// resolution. PATCH allow-lists NOTHING — there is no PATCH at all. Every
// transition is an explicit action, the same rule resolutions and elections
// already follow, because each carries its own preconditions and its own
// Board Service Change.
//
// The invariant that actually holds is interval NON-OVERLAP of
// [start_day, COALESCE(actual_end_day, scheduled_end_day)) per Person and
// independently per qualifying Lot, over uncancelled and unvoided rows — a
// partial index cannot express it, so every writer here carries it as
// conditional SQL (`noOverlapGuard`) inside its batch. Adjacency is legal:
// that is how renewal and succession are recorded, and a current term with a
// scheduled successor is exactly the shape re-election produces.

export const prerender = false;

const CONCLUDED = 'Term already concluded';
const PERSON_NOT_QUALIFIED =
  'Person does not currently own or represent that lot';
const PERSON_OVERLAP = 'Overlaps an existing term for this person';
const LOT_OVERLAP =
  'That lot already qualifies another board member for an overlapping term';

const CREATE_REASONS = new Set(['elected', 'vacancy_appointment']);
const END_REASONS = new Set([
  'term_expired',
  'resigned',
  'removed',
  'declared_vacant_absences',
]);
const CANCEL_REASONS = new Set(['resigned', 'removed', 'recorded_in_error']);

/** Board-service evidence: document / meeting / election / external /
 * operator_observation. NO `request` locator — `board_service_changes` has no
 * such column. */
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
        return { ok: false, error: 'evidence.documentId is required' };
      return { ok: true, value: { kind: 'document', documentId } };
    }
    case 'meeting': {
      const meetingId = str(r.meetingId);
      if (!meetingId)
        return { ok: false, error: 'evidence.meetingId is required' };
      return { ok: true, value: { kind: 'meeting', meetingId } };
    }
    case 'election': {
      const electionId = str(r.electionId);
      if (!electionId)
        return { ok: false, error: 'evidence.electionId is required' };
      return { ok: true, value: { kind: 'election', electionId } };
    }
    case 'external': {
      const externalReference = str(r.externalReference);
      if (!externalReference)
        return { ok: false, error: 'evidence.externalReference is required' };
      return { ok: true, value: { kind: 'external', externalReference } };
    }
    default:
      return { ok: false, error: 'evidence.kind is invalid' };
  }
}

async function actor(
  locals: App.Locals | undefined,
  request: Request,
): Promise<string> {
  const ctx = await resolveAuthContext(locals, request, env);
  return ctx?.userId ?? 'unknown';
}

interface TermRow {
  id: string;
  personId: string;
  qualifyingLotId: string | null;
  electionId: string | null;
  startDay: string;
  scheduledEndDay: string;
  actualEndDay: string | null;
  cancelledDay: string | null;
  cancelledAt: Date | null;
  voidedAt: Date | null;
}

async function loadTerm(termId: string): Promise<TermRow | null> {
  const [row] = await getDb(env)
    .select()
    .from(boardServiceTerms)
    .where(eq(boardServiceTerms.id, termId))
    .limit(1);
  return row ?? null;
}

const termConcluded = (t: TermRow): boolean =>
  t.actualEndDay !== null || t.cancelledAt !== null || t.voidedAt !== null;

/**
 * The concluding actions' shared tail: what happens to the term's current
 * office assignments and live Board grants when the term ends, cancels, or
 * voids. Enumerated pre-batch; every statement re-checks its row and the
 * term's own post-state marker inside the batch. The grant always ends at
 * Recorded At — never on the (possibly backdated) service day (#203).
 */
async function concludeTermTail(opts: {
  term: TermRow;
  mode: 'ended' | 'cancelled' | 'voided';
  effectiveDay: string;
  nowMs: number;
  actorAccountId: string;
  reason: BoardServiceReason;
  correlation: AuditCorrelation;
}): Promise<D1PreparedStatement[]> {
  const { term, mode, effectiveDay, nowMs, correlation } = opts;
  const statements: D1PreparedStatement[] = [];
  const termMarker = updatedRowGuard('board_service_terms', term.id, nowMs);

  const [offices, grants] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      mode === 'voided'
        ? `SELECT id, start_day, end_day FROM board_office_assignments
           WHERE board_term_id = ? AND voided_at IS NULL`
        : `SELECT id, start_day, end_day FROM board_office_assignments
           WHERE board_term_id = ? AND end_day IS NULL AND voided_at IS NULL`,
    ).bind(term.id),
    env.DATABASE.prepare(
      `SELECT id, account_id FROM access_grants
       WHERE qualifying_board_term_id = ? AND grant_type = 'board' AND ended_at IS NULL`,
    ).bind(term.id),
  ]);

  for (const office of offices.results as {
    id: string;
    start_day: string;
  }[]) {
    if (mode === 'ended') {
      // An office never ends before it began: a backdated term end inside the
      // assignment's own period leaves the minimal one-day assignment, honest
      // that it existed; phase 3d's flags own the window's actions.
      statements.push(
        env.DATABASE.prepare(
          `UPDATE board_office_assignments
           SET end_day = MAX(?, date(start_day, '+1 day')), updated_at = ?
           WHERE id = ? AND end_day IS NULL AND voided_at IS NULL AND (${termMarker.sql})`,
        ).bind(effectiveDay, nowMs, office.id, ...termMarker.binds),
      );
      correlation.event({
        kind: 'office_assignment_ended',
        actor: { kind: 'automatic', cause: `board_term_${mode}` },
        guard: {
          sql: `EXISTS (SELECT 1 FROM board_office_assignments WHERE id = ? AND updated_at = ? AND end_day IS NOT NULL)`,
          binds: [office.id, nowMs],
        },
        detail: {
          family: 'board_service_change',
          effective: { day: effectiveDay },
          reason: 'office_ended',
          evidence: OPERATOR_OBSERVATION,
          subjects: [
            { column: 'office_assignment_id', id: office.id, role: 'ended' },
            { column: 'board_term_id', id: term.id, role: 'related' },
          ],
        },
      });
    } else {
      // A cancelled term never ran and a voided one never was: an office on
      // it was never a fact either.
      statements.push(
        env.DATABASE.prepare(
          `UPDATE board_office_assignments SET voided_at = ?, updated_at = ?
           WHERE id = ? AND voided_at IS NULL AND (${termMarker.sql})`,
        ).bind(nowMs, nowMs, office.id, ...termMarker.binds),
      );
      correlation.event({
        kind: 'office_assignment_voided',
        actor: { kind: 'automatic', cause: `board_term_${mode}` },
        guard: {
          sql: `EXISTS (SELECT 1 FROM board_office_assignments WHERE id = ? AND updated_at = ? AND voided_at IS NOT NULL)`,
          binds: [office.id, nowMs],
        },
        detail: {
          family: 'board_service_change',
          effective: 'not_applicable',
          reason: 'recorded_in_error',
          evidence: OPERATOR_OBSERVATION,
          subjects: [
            { column: 'office_assignment_id', id: office.id, role: 'voided' },
            { column: 'board_term_id', id: term.id, role: 'related' },
          ],
        },
      });
    }
  }

  const grantEndReason =
    mode === 'ended'
      ? 'term_ended'
      : mode === 'cancelled'
        ? 'term_cancelled'
        : 'recorded_in_error';
  for (const grant of grants.results as { id: string; account_id: string }[]) {
    statements.push(
      env.DATABASE.prepare(
        `UPDATE access_grants SET ended_at = ?, ended_by_account_id = ?, end_reason = ?
         WHERE id = ? AND ended_at IS NULL AND (${termMarker.sql})`,
      ).bind(
        nowMs,
        opts.actorAccountId,
        grantEndReason,
        grant.id,
        ...termMarker.binds,
      ),
    );
    correlation.event({
      kind: 'grant_ended',
      actor: { kind: 'automatic', cause: `board_term_${mode}` },
      guard: {
        sql: `EXISTS (SELECT 1 FROM access_grants WHERE id = ? AND ended_at = ?)`,
        binds: [grant.id, nowMs],
      },
      detail: {
        family: 'access',
        grantId: grant.id,
        targetAccountId: grant.account_id,
        grantType: 'board',
        requestedAction: 'revoke',
        outcome: 'allowed',
        reason: grantEndReason,
      },
    });
  }
  return statements;
}

async function runTermBatch(
  primary: D1PreparedStatement,
  tail: D1PreparedStatement[],
  correlation: AuditCorrelation,
  conflict: string,
): Promise<Response> {
  const results = await env.DATABASE.batch([
    primary,
    ...tail,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response(conflict, { status: 409 });
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Term actions
// ---------------------------------------------------------------------------

async function createTerm(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const personId = stringField(body, 'personId');
  const qualifyingLotId = stringField(body, 'qualifyingLotId');
  const db = getDb(env);

  const personRows = await db
    .select({ partyId: people.partyId })
    .from(people)
    .where(eq(people.partyId, personId))
    .limit(1);
  if (personRows.length === 0)
    return new Response('Person not found', { status: 404 });
  const lotRows = await db
    .select({ id: properties.id, retiredAt: properties.retiredAt })
    .from(properties)
    .where(eq(properties.id, qualifyingLotId))
    .limit(1);
  if (lotRows.length === 0)
    return new Response('Lot not found', { status: 404 });
  if (lotRows[0].retiredAt !== null)
    return new Response('Lot is retired', { status: 409 });

  const reasonCode = stringField(body, 'reasonCode');
  if (!CREATE_REASONS.has(reasonCode))
    return new Response(
      "reasonCode must be 'elected' or 'vacancy_appointment'",
      { status: 400 },
    );

  const startDayResult = isoDateOrError(
    stringField(body, 'startDay'),
    'startDay',
  );
  if (!startDayResult.ok)
    return new Response(startDayResult.error, { status: 400 });
  const scheduledResult = isoDateOrError(
    stringField(body, 'scheduledEndDay'),
    'scheduledEndDay',
  );
  if (!scheduledResult.ok)
    return new Response(scheduledResult.error, { status: 400 });
  const startDay = startDayResult.value;
  const scheduledEndDay = scheduledResult.value;
  if (scheduledEndDay <= startDay)
    return new Response('scheduledEndDay must be after startDay', {
      status: 400,
    });

  const electionId = stringField(body, 'electionId') || null;
  if (electionId) {
    const rows = await db
      .select({ id: elections.id })
      .from(elections)
      .where(eq(elections.id, electionId))
      .limit(1);
    if (rows.length === 0)
      return new Response('Election not found', { status: 404 });
  }

  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  // Readable pre-checks, re-asserted inside the batch.
  const qualifies = qualifiesGuard(personId, qualifyingLotId, associationDay);
  const personClear = noOverlapGuard(
    'person_id',
    personId,
    startDay,
    scheduledEndDay,
  );
  const lotClear = noOverlapGuard(
    'qualifying_lot_id',
    qualifyingLotId,
    startDay,
    scheduledEndDay,
  );
  for (const [guard, message] of [
    [qualifies, PERSON_NOT_QUALIFIED],
    [personClear, PERSON_OVERLAP],
    [lotClear, LOT_OVERLAP],
  ] as const) {
    const row = await env.DATABASE.prepare(
      `SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS ok`,
    )
      .bind(...guard.binds)
      .first<{ ok: number }>();
    if (row?.ok !== 1) return new Response(message, { status: 409 });
  }

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, election_id, start_day, scheduled_end_day, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (${qualifies.sql}) AND (${personClear.sql}) AND (${lotClear.sql})
       AND EXISTS (SELECT 1 FROM properties WHERE id = ? AND retired_at IS NULL)`,
  ).bind(
    id,
    personId,
    qualifyingLotId,
    electionId,
    startDay,
    scheduledEndDay,
    nowMs,
    nowMs,
    ...qualifies.binds,
    ...personClear.binds,
    ...lotClear.binds,
    qualifyingLotId,
  );

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'createTerm'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'board_term_created',
    guard: insertedRowGuard('board_service_terms', id),
    detail: {
      family: 'board_service_change',
      effective: { day: startDay },
      reason: reasonCode as BoardServiceReason,
      evidence: evidenceResult.value,
      subjects: [
        { column: 'board_term_id', id, role: 'created' },
        { column: 'lot_id', id: qualifyingLotId, role: 'related' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Term conflicts with the current state', {
      status: 409,
    });
  return Response.json({ id }, { status: 201 });
}

async function endTerm(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const termId = stringField(body, 'termId');
  if (!termId) return new Response('termId is required', { status: 400 });
  const term = await loadTerm(termId);
  if (!term) return new Response('Term not found', { status: 404 });
  if (termConcluded(term)) return new Response(CONCLUDED, { status: 409 });

  const reasonCode = stringField(body, 'reasonCode');
  if (!END_REASONS.has(reasonCode))
    return new Response(
      "reasonCode must be one of 'term_expired', 'resigned', 'removed', 'declared_vacant_absences'",
      { status: 400 },
    );
  const endDayResult = isoDateOrError(stringField(body, 'endDay'), 'endDay');
  if (!endDayResult.ok)
    return new Response(endDayResult.error, { status: 400 });
  const endDay = endDayResult.value;
  if (endDay <= term.startDay)
    return new Response('endDay must be after the term starts', {
      status: 400,
    });
  if (endDay > associationDay)
    return new Response('endDay may not be in the future', { status: 400 });

  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const nowMs = Date.now();
  const actorAccountId = await actor(locals, request);
  const primary = env.DATABASE.prepare(
    `UPDATE board_service_terms SET actual_end_day = ?, updated_at = ?
     WHERE id = ? AND actual_end_day IS NULL AND cancelled_at IS NULL AND voided_at IS NULL`,
  ).bind(endDay, nowMs, termId);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'endTerm'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'board_term_ended',
    guard: updatedRowGuard('board_service_terms', termId, nowMs),
    detail: {
      family: 'board_service_change',
      effective: { day: endDay },
      reason: reasonCode as BoardServiceReason,
      evidence: evidenceResult.value,
      subjects: [
        { column: 'board_term_id', id: termId, role: 'ended' },
        ...(term.qualifyingLotId
          ? [
              {
                column: 'lot_id' as const,
                id: term.qualifyingLotId,
                role: 'related' as const,
              },
            ]
          : []),
      ],
    },
  });
  const tail = await concludeTermTail({
    term,
    mode: 'ended',
    effectiveDay: endDay,
    nowMs,
    actorAccountId,
    reason: reasonCode as BoardServiceReason,
    correlation,
  });
  return runTermBatch(primary, tail, correlation, CONCLUDED);
}

async function cancelTerm(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const termId = stringField(body, 'termId');
  if (!termId) return new Response('termId is required', { status: 400 });
  const term = await loadTerm(termId);
  if (!term) return new Response('Term not found', { status: 404 });
  if (termConcluded(term)) return new Response(CONCLUDED, { status: 409 });
  if (term.startDay <= associationDay)
    return new Response('Term already started — end it instead', {
      status: 409,
    });

  const reasonCode = stringField(body, 'reasonCode');
  if (!CANCEL_REASONS.has(reasonCode))
    return new Response(
      "reasonCode must be one of 'resigned', 'removed', 'recorded_in_error'",
      { status: 400 },
    );

  const nowMs = Date.now();
  const actorAccountId = await actor(locals, request);
  // The cancellation day is today, which precedes the (future) start day, so
  // `board_service_terms_cancelled_before_start` holds by construction.
  const primary = env.DATABASE.prepare(
    `UPDATE board_service_terms SET cancelled_day = ?, cancelled_at = ?, updated_at = ?
     WHERE id = ? AND actual_end_day IS NULL AND cancelled_at IS NULL AND voided_at IS NULL
       AND ? < start_day`,
  ).bind(associationDay, nowMs, nowMs, termId, associationDay);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'cancelTerm'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'board_term_cancelled',
    guard: updatedRowGuard('board_service_terms', termId, nowMs),
    detail: {
      family: 'board_service_change',
      effective: { day: associationDay },
      reason: reasonCode as BoardServiceReason,
      evidence: OPERATOR_OBSERVATION,
      subjects: [{ column: 'board_term_id', id: termId, role: 'voided' }],
    },
  });
  const tail = await concludeTermTail({
    term,
    mode: 'cancelled',
    effectiveDay: associationDay,
    nowMs,
    actorAccountId,
    reason: reasonCode as BoardServiceReason,
    correlation,
  });
  return runTermBatch(primary, tail, correlation, CONCLUDED);
}

async function voidTerm(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const termId = stringField(body, 'termId');
  if (!termId) return new Response('termId is required', { status: 400 });
  const term = await loadTerm(termId);
  if (!term) return new Response('Term not found', { status: 404 });
  if (term.voidedAt !== null)
    return new Response('Term already voided', { status: 409 });

  const nowMs = Date.now();
  const actorAccountId = await actor(locals, request);
  // The one-ending CHECK allows at most one of the three kinds, so voiding an
  // ended or cancelled term clears the other ending in the same statement.
  // The cleared values survive as scalar deltas on the event.
  const scalars: ScalarDelta[] = [];
  if (term.actualEndDay)
    scalars.push({
      fieldKey: 'actual_end_day',
      valueType: 'day',
      old: term.actualEndDay,
      new: null,
    });
  if (term.cancelledDay)
    scalars.push({
      fieldKey: 'cancelled_day',
      valueType: 'day',
      old: term.cancelledDay,
      new: null,
    });

  const primary = env.DATABASE.prepare(
    `UPDATE board_service_terms
     SET voided_at = ?, actual_end_day = NULL, cancelled_day = NULL, cancelled_at = NULL, updated_at = ?
     WHERE id = ? AND voided_at IS NULL`,
  ).bind(nowMs, nowMs, termId);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'voidTerm'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'board_term_voided',
    guard: updatedRowGuard('board_service_terms', termId, nowMs),
    scalars,
    detail: {
      family: 'board_service_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: OPERATOR_OBSERVATION,
      subjects: [{ column: 'board_term_id', id: termId, role: 'voided' }],
    },
  });
  const tail = await concludeTermTail({
    term,
    mode: 'voided',
    effectiveDay: associationDateIso(),
    nowMs,
    actorAccountId,
    reason: 'recorded_in_error',
    correlation,
  });
  return runTermBatch(primary, tail, correlation, 'Term already voided');
}

async function substituteQualifyingLot(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const termId = stringField(body, 'termId');
  const qualifyingLotId = stringField(body, 'qualifyingLotId');
  if (!termId) return new Response('termId is required', { status: 400 });
  const term = await loadTerm(termId);
  if (!term) return new Response('Term not found', { status: 404 });
  const db = getDb(env);
  const lotRows = await db
    .select({ id: properties.id, retiredAt: properties.retiredAt })
    .from(properties)
    .where(eq(properties.id, qualifyingLotId))
    .limit(1);
  if (lotRows.length === 0)
    return new Response('Lot not found', { status: 404 });
  if (lotRows[0].retiredAt !== null)
    return new Response('Lot is retired', { status: 409 });
  if (termConcluded(term)) return new Response(CONCLUDED, { status: 409 });
  if (term.qualifyingLotId === qualifyingLotId)
    return new Response('That is already the qualifying lot', { status: 400 });

  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const qualifies = qualifiesGuard(
    term.personId,
    qualifyingLotId,
    associationDay,
  );
  const lotClear = noOverlapGuard(
    'qualifying_lot_id',
    qualifyingLotId,
    term.startDay,
    term.scheduledEndDay,
    termId,
  );
  for (const [guard, message] of [
    [qualifies, PERSON_NOT_QUALIFIED],
    [lotClear, LOT_OVERLAP],
  ] as const) {
    const row = await env.DATABASE.prepare(
      `SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS ok`,
    )
      .bind(...guard.binds)
      .first<{ ok: number }>();
    if (row?.ok !== 1) return new Response(message, { status: 409 });
  }

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE board_service_terms SET qualifying_lot_id = ?, updated_at = ?
     WHERE id = ? AND actual_end_day IS NULL AND cancelled_at IS NULL AND voided_at IS NULL
       AND (${qualifies.sql}) AND (${lotClear.sql})`,
  ).bind(qualifyingLotId, nowMs, termId, ...qualifies.binds, ...lotClear.binds);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'substituteQualifyingLot'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'qualifying_lot_substituted',
    guard: {
      sql: `EXISTS (SELECT 1 FROM board_service_terms WHERE id = ? AND qualifying_lot_id = ? AND updated_at = ?)`,
      binds: [termId, qualifyingLotId, nowMs],
    },
    detail: {
      family: 'board_service_change',
      effective: { day: associationDay },
      reason: 'qualifying_lot_substituted',
      evidence: evidenceResult.value,
      subjects: [
        { column: 'board_term_id', id: termId, role: 'primary' },
        ...(term.qualifyingLotId
          ? [
              {
                column: 'lot_id' as const,
                id: term.qualifyingLotId,
                role: 'related' as const,
              },
            ]
          : []),
        { column: 'lot_id', id: qualifyingLotId, role: 'replacement' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Substitution conflicts with the current state', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

async function correctTerm(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const termId = stringField(body, 'termId');
  if (!termId) return new Response('termId is required', { status: 400 });
  const term = await loadTerm(termId);
  if (!term) return new Response('Term not found', { status: 404 });

  const record = body as Record<string, unknown>;
  const hasLot = 'qualifyingLotId' in record;
  const hasElection = 'electionId' in record;
  if (!hasLot && !hasElection)
    return new Response('No fields to correct', { status: 400 });

  // #203's in-place line: qualifying_lot_id (as a factual correction) and
  // election_id as provenance metadata. Everything else — person, endpoints,
  // endings — is void-and-recreate, because a different person or period is a
  // different fact, not an edit.
  const qualifyingLotId = hasLot ? stringField(body, 'qualifyingLotId') : null;
  let electionId: string | null = null;
  if (hasElection && record.electionId !== null) {
    electionId = stringField(body, 'electionId');
    const rows = await getDb(env)
      .select({ id: elections.id })
      .from(elections)
      .where(eq(elections.id, electionId))
      .limit(1);
    if (rows.length === 0)
      return new Response('Election not found', { status: 404 });
  }

  const guards: SqlGuard[] = [];
  if (hasLot) {
    if (!qualifyingLotId)
      return new Response('qualifyingLotId is required', { status: 400 });
    const lotRows = await getDb(env)
      .select({ id: properties.id, retiredAt: properties.retiredAt })
      .from(properties)
      .where(eq(properties.id, qualifyingLotId))
      .limit(1);
    if (lotRows.length === 0)
      return new Response('Lot not found', { status: 404 });
    if (lotRows[0].retiredAt !== null)
      return new Response('Lot is retired', { status: 409 });
    const qualifies = qualifiesGuard(
      term.personId,
      qualifyingLotId,
      associationDay,
    );
    const lotClear = noOverlapGuard(
      'qualifying_lot_id',
      qualifyingLotId,
      term.startDay,
      term.scheduledEndDay,
      termId,
    );
    for (const [guard, message] of [
      [qualifies, PERSON_NOT_QUALIFIED],
      [lotClear, LOT_OVERLAP],
    ] as const) {
      const row = await env.DATABASE.prepare(
        `SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS ok`,
      )
        .bind(...guard.binds)
        .first<{ ok: number }>();
      if (row?.ok !== 1) return new Response(message, { status: 409 });
    }
    guards.push(qualifies, lotClear);
  }

  const nowMs = Date.now();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (hasLot) {
    sets.push('qualifying_lot_id = ?');
    binds.push(qualifyingLotId);
  }
  if (hasElection) {
    sets.push('election_id = ?');
    binds.push(electionId);
  }
  sets.push('updated_at = ?');
  binds.push(nowMs);
  const guardSql = guards.map((g) => ` AND (${g.sql})`).join('');
  const primary = env.DATABASE.prepare(
    `UPDATE board_service_terms SET ${sets.join(', ')} WHERE id = ?${guardSql}`,
  ).bind(...binds, termId, ...guards.flatMap((g) => g.binds));

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'correctTerm'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'board_term_corrected',
    guard: updatedRowGuard('board_service_terms', termId, nowMs),
    detail: {
      family: 'board_service_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence:
        hasElection && electionId
          ? { kind: 'election', electionId }
          : OPERATOR_OBSERVATION,
      subjects: [
        { column: 'board_term_id', id: termId, role: 'primary' },
        ...(hasLot && term.qualifyingLotId
          ? [
              {
                column: 'lot_id' as const,
                id: term.qualifyingLotId,
                role: 'related' as const,
              },
            ]
          : []),
        ...(hasLot && qualifyingLotId
          ? [
              {
                column: 'lot_id' as const,
                id: qualifyingLotId,
                role: 'replacement' as const,
              },
            ]
          : []),
      ],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Correction conflicts with the current state', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Office actions
// ---------------------------------------------------------------------------

async function assignOffice(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const termId = stringField(body, 'termId');
  if (!termId) return new Response('termId is required', { status: 400 });
  const term = await loadTerm(termId);
  if (!term) return new Response('Term not found', { status: 404 });
  if (termConcluded(term)) return new Response(CONCLUDED, { status: 409 });

  const office = stringField(body, 'office');
  if (!(OFFICES as readonly string[]).includes(office))
    return new Response(
      "office must be one of 'president', 'vice_president', 'secretary_treasurer'",
      { status: 400 },
    );

  let startDay = associationDay;
  const startDayRaw = stringField(body, 'startDay');
  if (startDayRaw) {
    const result = isoDateOrError(startDayRaw, 'startDay');
    if (!result.ok) return new Response(result.error, { status: 400 });
    startDay = result.value;
  }
  // Containment: an assignment belongs to a single term and never carries
  // across into a later one (#203).
  if (startDay < term.startDay || startDay >= term.scheduledEndDay)
    return new Response('Office must start within the term', { status: 400 });

  const officeClear: SqlGuard = {
    sql: `NOT EXISTS (SELECT 1 FROM board_office_assignments WHERE office = ? AND end_day IS NULL AND voided_at IS NULL)`,
    binds: [office],
  };
  const personClear: SqlGuard = {
    sql: `NOT EXISTS (SELECT 1 FROM board_office_assignments WHERE person_id = ? AND end_day IS NULL AND voided_at IS NULL)`,
    binds: [term.personId],
  };
  for (const [guard, message] of [
    [officeClear, 'That office already has a current holder'],
    [personClear, 'This person already holds an office'],
  ] as const) {
    const row = await env.DATABASE.prepare(
      `SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS ok`,
    )
      .bind(...guard.binds)
      .first<{ ok: number }>();
    if (row?.ok !== 1) return new Response(message, { status: 409 });
  }

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `INSERT INTO board_office_assignments (id, board_term_id, person_id, office, start_day, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE (${officeClear.sql}) AND (${personClear.sql})
       AND EXISTS (
         SELECT 1 FROM board_service_terms
         WHERE id = ? AND actual_end_day IS NULL AND cancelled_at IS NULL AND voided_at IS NULL
       )`,
  ).bind(
    id,
    termId,
    term.personId,
    office,
    startDay,
    nowMs,
    nowMs,
    ...officeClear.binds,
    ...personClear.binds,
    termId,
  );

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'assignOffice'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'office_assigned',
    guard: insertedRowGuard('board_office_assignments', id),
    detail: {
      family: 'board_service_change',
      effective: { day: startDay },
      reason: 'office_assigned',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'office_assignment_id', id, role: 'created' },
        { column: 'board_term_id', id: termId, role: 'related' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Office assignment conflicts with the current state', {
      status: 409,
    });
  return Response.json({ id }, { status: 201 });
}

interface OfficeRow {
  id: string;
  boardTermId: string;
  startDay: string;
  endDay: string | null;
  voidedAt: Date | null;
}

async function loadOffice(id: string): Promise<OfficeRow | null> {
  const [row] = await getDb(env)
    .select()
    .from(boardOfficeAssignments)
    .where(eq(boardOfficeAssignments.id, id))
    .limit(1);
  return row ?? null;
}

async function endOffice(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const assignmentId = stringField(body, 'assignmentId');
  if (!assignmentId)
    return new Response('assignmentId is required', { status: 400 });
  const office = await loadOffice(assignmentId);
  if (!office) return new Response('Assignment not found', { status: 404 });
  if (office.endDay !== null || office.voidedAt !== null)
    return new Response('Assignment already concluded', { status: 409 });

  let endDay = associationDay;
  const endDayRaw = stringField(body, 'endDay');
  if (endDayRaw) {
    const result = isoDateOrError(endDayRaw, 'endDay');
    if (!result.ok) return new Response(result.error, { status: 400 });
    endDay = result.value;
  }
  if (endDay <= office.startDay)
    return new Response('endDay must be after the assignment starts', {
      status: 400,
    });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE board_office_assignments SET end_day = ?, updated_at = ?
     WHERE id = ? AND end_day IS NULL AND voided_at IS NULL`,
  ).bind(endDay, nowMs, assignmentId);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'endOffice'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'office_assignment_ended',
    guard: updatedRowGuard('board_office_assignments', assignmentId, nowMs),
    detail: {
      family: 'board_service_change',
      effective: { day: endDay },
      reason: 'office_ended',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'office_assignment_id', id: assignmentId, role: 'ended' },
        { column: 'board_term_id', id: office.boardTermId, role: 'related' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Assignment already concluded', { status: 409 });
  return new Response(null, { status: 204 });
}

async function voidOffice(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const assignmentId = stringField(body, 'assignmentId');
  if (!assignmentId)
    return new Response('assignmentId is required', { status: 400 });
  const office = await loadOffice(assignmentId);
  if (!office) return new Response('Assignment not found', { status: 404 });
  if (office.voidedAt !== null)
    return new Response('Assignment already voided', { status: 409 });

  const nowMs = Date.now();
  const scalars: ScalarDelta[] = office.endDay
    ? [
        {
          fieldKey: 'end_day',
          valueType: 'day',
          old: office.endDay,
          new: null,
        },
      ]
    : [];
  const primary = env.DATABASE.prepare(
    `UPDATE board_office_assignments SET voided_at = ?, end_day = NULL, updated_at = ?
     WHERE id = ? AND voided_at IS NULL`,
  ).bind(nowMs, nowMs, assignmentId);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('board-service', 'voidOffice'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'office_assignment_voided',
    guard: updatedRowGuard('board_office_assignments', assignmentId, nowMs),
    scalars,
    detail: {
      family: 'board_service_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'office_assignment_id', id: assignmentId, role: 'voided' },
        { column: 'board_term_id', id: office.boardTermId, role: 'related' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Assignment already voided', { status: 409 });
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchBoardService(env, associationDateIso()));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const action = stringField(parsed.value, 'action');
  const associationDay = associationDateIso();

  switch (action) {
    case 'createTerm':
      return createTerm(parsed.value, locals, request, associationDay);
    case 'endTerm':
      return endTerm(parsed.value, locals, request, associationDay);
    case 'cancelTerm':
      return cancelTerm(parsed.value, locals, request, associationDay);
    case 'voidTerm':
      return voidTerm(parsed.value, locals, request);
    case 'substituteQualifyingLot':
      return substituteQualifyingLot(
        parsed.value,
        locals,
        request,
        associationDay,
      );
    case 'correctTerm':
      return correctTerm(parsed.value, locals, request, associationDay);
    case 'assignOffice':
      return assignOffice(parsed.value, locals, request, associationDay);
    case 'endOffice':
      return endOffice(parsed.value, locals, request, associationDay);
    case 'voidOffice':
      return voidOffice(parsed.value, locals, request);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
