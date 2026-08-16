import type { APIRoute } from 'astro';
import { and, eq, gt, isNull } from 'drizzle-orm';
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
import { parties, ownerships } from '../../../server/db/roster-schema';
import {
  AuditCorrelation,
  assertInBatch,
  insertedRowGuard,
  isBatchAssertionError,
  operationKey,
  updatedRowGuard,
  OPERATOR_OBSERVATION,
  type Evidence,
} from '../../../server/roster/audit';
import { lossConsequences } from '../../../server/roster/board-consequences';
import { transferEffects } from '../../../server/roster/transfer-effects';

// ADR 0022 phase 3b (#218): the Ownership half of the roster's recorded-fact
// surfaces. See docs/adr/0022-party-roster-derived-access.md and
// AGENT-BRIEF-3b.md for the contract this route implements.
//
// Every mutation is one D1 batch: the primary domain statement, then (for
// `end`/`void`) the substitute-or-terminate consequence engine's statements,
// then the audit correlation's ledger statements, then any
// `assertInBatch` guards for a named substitute that failed validation.

export const prerender = false;

const SUBSTITUTE_FAILED = 'A named substitute lot no longer qualifies';

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
    case 'meeting': {
      const meetingId = str(r.meetingId);
      if (!meetingId)
        return {
          ok: false,
          error: 'evidence.meetingId is required for evidence.kind meeting',
        };
      return { ok: true, value: { kind: 'meeting', meetingId } };
    }
    case 'election': {
      const electionId = str(r.electionId);
      if (!electionId)
        return {
          ok: false,
          error: 'evidence.electionId is required for evidence.kind election',
        };
      return { ok: true, value: { kind: 'election', electionId } };
    }
    case 'request': {
      const requestId = str(r.requestId);
      if (!requestId)
        return {
          ok: false,
          error: 'evidence.requestId is required for evidence.kind request',
        };
      return { ok: true, value: { kind: 'request', requestId } };
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

/** `substitutions?: [{termId, qualifyingLotId}]` -> a Map, or a 400. */
function parseSubstitutions(
  body: unknown,
): { ok: true; value: Map<string, string> } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)
    ?.substitutions;
  if (raw === undefined) return { ok: true, value: new Map() };
  if (!Array.isArray(raw))
    return { ok: false, error: 'substitutions must be an array' };
  const map = new Map<string, string>();
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    const termId = r?.termId;
    const qualifyingLotId = r?.qualifyingLotId;
    if (typeof termId !== 'string' || termId.trim() === '')
      return { ok: false, error: 'Each substitution needs a termId' };
    if (typeof qualifyingLotId !== 'string' || qualifyingLotId.trim() === '')
      return {
        ok: false,
        error: 'Each substitution needs a qualifyingLotId',
      };
    map.set(termId.trim(), qualifyingLotId.trim());
  }
  return { ok: true, value: map };
}

async function createOwnership(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const ownerPartyId = stringField(body, 'ownerPartyId');
  const lotId = stringField(body, 'lotId');
  const db = getDb(env);

  const partyRows = await db
    .select({
      id: parties.id,
      consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
    })
    .from(parties)
    .where(eq(parties.id, ownerPartyId))
    .limit(1);
  if (partyRows.length === 0)
    return new Response('Party not found', { status: 404 });
  const lotRows = await db
    .select({ id: properties.id, retiredAt: properties.retiredAt })
    .from(properties)
    .where(eq(properties.id, lotId))
    .limit(1);
  if (lotRows.length === 0)
    return new Response('Lot not found', { status: 404 });
  if (partyRows[0].consolidatedIntoPartyId !== null)
    return new Response(
      'Party has been consolidated — record facts on the survivor',
      { status: 409 },
    );
  if (lotRows[0].retiredAt !== null)
    return new Response('Lot is retired', { status: 409 });

  const startDayRaw = stringField(body, 'startDay');
  if (!startDayRaw)
    return new Response('startDay is required', { status: 400 });
  const startDayResult = isoDateOrError(startDayRaw, 'startDay');
  if (!startDayResult.ok)
    return new Response(startDayResult.error, { status: 400 });
  const startDay = startDayResult.value;
  if (startDay > associationDay)
    return new Response('startDay may not be in the future', {
      status: 400,
    });

  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const currentRows = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerPartyId, ownerPartyId),
        eq(ownerships.lotId, lotId),
        isNull(ownerships.endDay),
        isNull(ownerships.voidedAt),
      ),
    )
    .limit(1);
  if (currentRows.length > 0)
    return new Response(
      'This party already holds a current ownership of this lot',
      { status: 409 },
    );

  // General interval overlap: the new Ownership's interval is always
  // [startDay, +infinity) here (create never accepts an endDay), so the
  // symmetric verify-invariants.ts predicate collapses to "does an existing,
  // unvoided row's own interval reach past startDay" — an open row (end_day
  // NULL) always does, which is also what makes this subsume the "current"
  // check above.
  const overlapRows = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerPartyId, ownerPartyId),
        eq(ownerships.lotId, lotId),
        isNull(ownerships.voidedAt),
        gt(ownerships.endDay, startDay),
      ),
    )
    .limit(1);
  // drizzle's gt() on a nullable column excludes NULLs at the SQL level, so
  // the still-open case above is re-checked separately (currentRows) and the
  // two 409s are mutually exclusive in practice, current-first.
  if (overlapRows.length > 0)
    return new Response(
      'Overlaps a recorded ownership period for this party and lot',
      { status: 409 },
    );

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM parties WHERE id = ? AND consolidated_into_party_id IS NULL)
       AND EXISTS (SELECT 1 FROM properties WHERE id = ? AND retired_at IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM ownerships
         WHERE owner_party_id = ? AND lot_id = ? AND voided_at IS NULL
           AND (end_day IS NULL OR ? < end_day)
       )`,
  ).bind(
    id,
    ownerPartyId,
    lotId,
    startDay,
    nowMs,
    nowMs,
    ownerPartyId,
    lotId,
    ownerPartyId,
    lotId,
    startDay,
  );

  const ctx = await resolveAuthContext(locals, request, env);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-ownerships', 'create'),
    actorAccountId: ctx?.userId ?? 'unknown',
    nowMs,
  });
  correlation.event({
    kind: 'ownership_recorded',
    guard: insertedRowGuard('ownerships', id),
    detail: {
      family: 'roster_change',
      effective: { day: startDay },
      reason: 'board_recorded',
      evidence: evidenceResult.value,
      subjects: [
        { column: 'ownership_id', id, role: 'created' },
        { column: 'lot_id', id: lotId, role: 'related' },
        { column: 'party_id', id: ownerPartyId, role: 'related' },
      ],
    },
  });

  let results;
  try {
    results = await env.DATABASE.batch([primary, ...correlation.statements]);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response(SUBSTITUTE_FAILED, { status: 409 });
    throw e;
  }
  if (results[0].meta.changes !== 1)
    return new Response(
      'Ownership could not be recorded — it may already exist or the lot may have been retired',
      { status: 409 },
    );
  return Response.json({ id }, { status: 201 });
}

async function endOwnership(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const ownershipId = stringField(body, 'ownershipId');
  if (!ownershipId)
    return new Response('ownershipId is required', { status: 400 });

  const db = getDb(env);
  const existingRows = await db
    .select()
    .from(ownerships)
    .where(eq(ownerships.id, ownershipId))
    .limit(1);
  if (existingRows.length === 0)
    return new Response('Ownership not found', { status: 404 });
  const existing = existingRows[0];
  if (existing.voidedAt !== null)
    return new Response('Ownership was voided', { status: 409 });
  if (existing.endDay !== null)
    return new Response('Ownership already ended', { status: 409 });

  const endDayRaw = stringField(body, 'endDay');
  if (!endDayRaw) return new Response('endDay is required', { status: 400 });
  const endDayResult = isoDateOrError(endDayRaw, 'endDay');
  if (!endDayResult.ok)
    return new Response(endDayResult.error, { status: 400 });
  const endDay = endDayResult.value;
  if (existing.startDay !== null && endDay <= existing.startDay)
    return new Response('endDay must be after startDay', { status: 400 });
  if (endDay > associationDay)
    return new Response('endDay may not be in the future', { status: 400 });

  const substitutionsResult = parseSubstitutions(body);
  if (!substitutionsResult.ok)
    return new Response(substitutionsResult.error, { status: 400 });
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE ownerships SET end_day = ?, updated_at = ?
     WHERE id = ? AND end_day IS NULL AND voided_at IS NULL`,
  ).bind(endDay, nowMs, ownershipId);
  const rootGuard = updatedRowGuard('ownerships', ownershipId, nowMs);

  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-ownerships', 'end'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'ownership_ended',
    guard: rootGuard,
    detail: {
      family: 'roster_change',
      effective: { day: endDay },
      reason: 'ownership_transfer',
      evidence: evidenceResult.value,
      subjects: [
        { column: 'ownership_id', id: ownershipId, role: 'ended' },
        { column: 'lot_id', id: existing.lotId, role: 'related' },
        { column: 'party_id', id: existing.ownerPartyId, role: 'related' },
      ],
    },
  });

  const consequences = await lossConsequences({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: endDay,
    lots: [existing.lotId],
    rootGuard,
    substitutions: substitutionsResult.value,
    cause: 'ownership_ended',
    correlation,
    actorAccountId,
  });

  // Phase 3d (#220): the transfer itself. The one stored action a transfer
  // reverses is an open member-motion vote; everything else it disturbs —
  // backdated-window activity and still-upcoming occasions — is surfaced as a
  // Review Flag. Flag INSERTs FK-reference their opening events, so they come
  // AFTER the correlation's statements.
  const effects = await transferEffects({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: endDay,
    lots: [existing.lotId],
    rootGuard,
    correlation,
    cause: 'ownership_ended',
    resetOpenMotionVotes: true,
    affectedTermIds: consequences.affectedTermIds,
  });

  const batch = [
    primary,
    ...consequences.statements,
    ...effects.statements,
    ...correlation.statements,
    ...effects.flagStatements,
    ...consequences.substitutionAsserts.map((g) =>
      assertInBatch(env.DATABASE, g),
    ),
  ];

  let results;
  try {
    results = await env.DATABASE.batch(batch);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response(SUBSTITUTE_FAILED, { status: 409 });
    throw e;
  }
  if (results[0].meta.changes !== 1)
    return new Response('Ownership already ended or voided', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

async function voidOwnership(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const ownershipId = stringField(body, 'ownershipId');
  if (!ownershipId)
    return new Response('ownershipId is required', { status: 400 });

  const db = getDb(env);
  const existingRows = await db
    .select()
    .from(ownerships)
    .where(eq(ownerships.id, ownershipId))
    .limit(1);
  if (existingRows.length === 0)
    return new Response('Ownership not found', { status: 404 });
  const existing = existingRows[0];
  if (existing.voidedAt !== null)
    return new Response('Ownership already voided', { status: 409 });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE ownerships SET voided_at = ?, updated_at = ?
     WHERE id = ? AND voided_at IS NULL`,
  ).bind(nowMs, nowMs, ownershipId);
  const rootGuard = updatedRowGuard('ownerships', ownershipId, nowMs);

  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-ownerships', 'void'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'ownership_voided',
    guard: rootGuard,
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'ownership_id', id: ownershipId, role: 'voided' },
        { column: 'lot_id', id: existing.lotId, role: 'related' },
      ],
    },
  });

  // An already-ended row may still be voided: a real early end can itself
  // have been recorded in error. Its qualifying consequence, if any, was
  // already resolved by the `end` command; re-running the engine here is
  // harmless (it finds nothing left to affect) and keeps this action simple.
  const consequences = await lossConsequences({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: associationDay,
    lots: [existing.lotId],
    rootGuard,
    substitutions: new Map(),
    cause: 'ownership_voided',
    correlation,
    actorAccountId,
  });

  // A void is NOT a transfer: no vote is reset (#204 — a reset vote is never
  // restored either, and fabricating one back is worse than the friction).
  // Its own flags resolve as `superseded`, never deleted. Discovery still
  // runs, but its window opens today, so in practice only the forward pass
  // has anything to say.
  const effects = await transferEffects({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: associationDay,
    lots: [existing.lotId],
    rootGuard,
    correlation,
    cause: 'ownership_voided',
    affectedTermIds: consequences.affectedTermIds,
    supersedes: { column: 'ownership_id', id: ownershipId },
  });

  const batch = [
    primary,
    ...consequences.statements,
    ...effects.statements,
    ...correlation.statements,
    ...effects.flagStatements,
    ...consequences.substitutionAsserts.map((g) =>
      assertInBatch(env.DATABASE, g),
    ),
  ];

  let results;
  try {
    results = await env.DATABASE.batch(batch);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response(SUBSTITUTE_FAILED, { status: 409 });
    throw e;
  }
  if (results[0].meta.changes !== 1)
    return new Response('Ownership already voided', { status: 409 });
  return new Response(null, { status: 204 });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const action = stringField(parsed.value, 'action');
  const associationDay = associationDateIso();

  switch (action) {
    case 'create':
      return createOwnership(parsed.value, locals, request, associationDay);
    case 'end':
      return endOwnership(parsed.value, locals, request, associationDay);
    case 'void':
      return voidOwnership(parsed.value, locals, request, associationDay);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
