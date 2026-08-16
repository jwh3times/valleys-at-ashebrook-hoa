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
import {
  parties,
  people,
  organizations,
  representations,
} from '../../../server/db/roster-schema';
import {
  AuditCorrelation,
  assertInBatch,
  insertedRowGuard,
  isBatchAssertionError,
  operationKey,
  updatedRowGuard,
  OPERATOR_OBSERVATION,
  type Evidence,
  type RosterSubjectColumn,
  type SubjectRole,
} from '../../../server/roster/audit';
import { lossConsequences } from '../../../server/roster/board-consequences';
import { transferEffects } from '../../../server/roster/transfer-effects';

// ADR 0022 phase 3b (#218): the Representation half of the roster's
// recorded-fact surfaces. See AGENT-BRIEF-3b.md and
// src/pages/api/admin/roster-ownerships.ts (the sibling route) for the shared
// batch/ledger protocol this file follows.

export const prerender = false;

const SUBSTITUTE_FAILED = 'A named substitute lot no longer qualifies';
const CONCLUDED =
  'Representation has concluded — scope can no longer be corrected';

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

/** Every lot the Organization currently (as of `associationDay`) owns. */
async function orgCurrentOwnershipLots(
  organizationPartyId: string,
  associationDay: string,
): Promise<string[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT lot_id FROM ownerships
     WHERE owner_party_id = ? AND voided_at IS NULL
       AND (start_day IS NULL OR start_day <= ?)
       AND (end_day IS NULL OR ? < end_day)`,
  )
    .bind(organizationPartyId, associationDay, associationDay)
    .all<{ lot_id: string }>();
  return rows.results.map((r) => r.lot_id);
}

async function orgCurrentlyOwnsLot(
  organizationPartyId: string,
  lotId: string,
  associationDay: string,
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 FROM ownerships
     WHERE owner_party_id = ? AND lot_id = ? AND voided_at IS NULL
       AND (start_day IS NULL OR start_day <= ?)
       AND (end_day IS NULL OR ? < end_day)
     LIMIT 1`,
  )
    .bind(organizationPartyId, lotId, associationDay, associationDay)
    .first();
  return row !== null;
}

/** The lots a Representation covers right now: dynamic for 'organization'
 * scope, the explicit unvoided set for 'lots' scope. */
async function coveredLots(
  rep: {
    id: string;
    organizationPartyId: string;
    scopeKind: 'organization' | 'lots';
  },
  associationDay: string,
): Promise<string[]> {
  if (rep.scopeKind === 'organization')
    return orgCurrentOwnershipLots(rep.organizationPartyId, associationDay);
  const rows = await env.DATABASE.prepare(
    `SELECT lot_id FROM representation_lots WHERE representation_id = ? AND voided_at IS NULL`,
  )
    .bind(rep.id)
    .all<{ lot_id: string }>();
  return rows.results.map((r) => r.lot_id);
}

interface ScopeInput {
  scopeKind: 'organization' | 'lots';
  lotIds: string[];
}

/** Shared by `create` and `correctScope`: the scope-kind/lotIds XOR shape,
 * plus — for 'lots' — that every named lot is one the Organization currently
 * owns. */
async function validateScope(
  body: unknown,
  organizationPartyId: string,
  associationDay: string,
): Promise<
  { ok: true; value: ScopeInput } | { ok: false; response: Response }
> {
  const r = body as Record<string, unknown> | null | undefined;
  const scopeKind = r?.scopeKind;
  if (scopeKind !== 'organization' && scopeKind !== 'lots')
    return {
      ok: false,
      response: new Response("scopeKind must be 'organization' or 'lots'", {
        status: 400,
      }),
    };
  if (scopeKind === 'organization') {
    if (r && 'lotIds' in r)
      return {
        ok: false,
        response: new Response(
          'lotIds is not allowed when scopeKind is organization',
          { status: 400 },
        ),
      };
    return { ok: true, value: { scopeKind, lotIds: [] } };
  }
  const rawLotIds = r?.lotIds;
  if (!Array.isArray(rawLotIds) || rawLotIds.length === 0)
    return {
      ok: false,
      response: new Response(
        'lotIds must be a non-empty array for scope lots',
        {
          status: 400,
        },
      ),
    };
  const lotIds: string[] = [];
  for (const raw of rawLotIds) {
    if (typeof raw !== 'string' || raw.trim() === '')
      return {
        ok: false,
        response: new Response('Each lotId must be a non-empty string', {
          status: 400,
        }),
      };
    lotIds.push(raw.trim());
  }
  if (new Set(lotIds).size !== lotIds.length)
    return {
      ok: false,
      response: new Response('lotIds must not repeat a lot', { status: 400 }),
    };
  const db = getDb(env);
  for (const lotId of lotIds) {
    const lotRows = await db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.id, lotId))
      .limit(1);
    if (lotRows.length === 0)
      return {
        ok: false,
        response: new Response('Lot not found', { status: 404 }),
      };
    if (
      !(await orgCurrentlyOwnsLot(organizationPartyId, lotId, associationDay))
    )
      return {
        ok: false,
        response: new Response('Organization does not currently own that lot', {
          status: 409,
        }),
      };
  }
  return { ok: true, value: { scopeKind, lotIds } };
}

async function createRepresentation(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const representativePersonId = stringField(body, 'representativePersonId');
  const organizationPartyId = stringField(body, 'organizationPartyId');
  const db = getDb(env);

  const personRows = await db
    .select({
      id: people.partyId,
      consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
    })
    .from(people)
    .innerJoin(parties, eq(parties.id, people.partyId))
    .where(eq(people.partyId, representativePersonId))
    .limit(1);
  if (personRows.length === 0)
    return new Response('Person not found', { status: 404 });
  const orgRows = await db
    .select({
      id: organizations.partyId,
      consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
    })
    .from(organizations)
    .innerJoin(parties, eq(parties.id, organizations.partyId))
    .where(eq(organizations.partyId, organizationPartyId))
    .limit(1);
  if (orgRows.length === 0)
    return new Response('Organization not found', { status: 404 });
  if (personRows[0].consolidatedIntoPartyId !== null)
    return new Response(
      'Party has been consolidated — record facts on the survivor',
      { status: 409 },
    );
  if (orgRows[0].consolidatedIntoPartyId !== null)
    return new Response(
      'Party has been consolidated — record facts on the survivor',
      { status: 409 },
    );

  const scopeResult = await validateScope(
    body,
    organizationPartyId,
    associationDay,
  );
  if (!scopeResult.ok) return scopeResult.response;

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

  // Unlike an Ownership end, a Representation end MAY be future-dated at
  // creation: a management agreement has a written term (schema comment on
  // representations.endDay).
  let endDay: string | null = null;
  const endDayRaw = stringField(body, 'endDay');
  if (endDayRaw) {
    const endDayResult = isoDateOrError(endDayRaw, 'endDay');
    if (!endDayResult.ok)
      return new Response(endDayResult.error, { status: 400 });
    endDay = endDayResult.value;
  }
  if (endDay !== null && endDay <= startDay)
    return new Response('endDay must be after startDay', { status: 400 });

  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const currentRows = await db
    .select({ id: representations.id })
    .from(representations)
    .where(
      and(
        eq(representations.representativePersonId, representativePersonId),
        eq(representations.organizationPartyId, organizationPartyId),
        isNull(representations.endDay),
        isNull(representations.voidedAt),
      ),
    )
    .limit(1);
  if (currentRows.length > 0)
    return new Response(
      'This person already has an effective representation for this organization',
      { status: 409 },
    );

  // General interval overlap (verify-invariants.ts's representation_overlap
  // predicate): an existing row overlaps the new [startDay, endDay ?? +inf)
  // interval when its own start precedes the new end AND the new start
  // precedes its own end. representations.start_day is NOT NULL, so only the
  // "new end" side of the first clause can be open.
  let overlapExists = false;
  if (endDay === null) {
    const rows = await db
      .select({ id: representations.id })
      .from(representations)
      .where(
        and(
          eq(representations.representativePersonId, representativePersonId),
          eq(representations.organizationPartyId, organizationPartyId),
          isNull(representations.voidedAt),
          gt(representations.endDay, startDay),
        ),
      )
      .limit(1);
    overlapExists = rows.length > 0 || currentRows.length > 0;
  } else {
    const rows = await env.DATABASE.prepare(
      `SELECT 1 FROM representations
       WHERE representative_person_id = ? AND organization_party_id = ? AND voided_at IS NULL
         AND start_day < ? AND (end_day IS NULL OR ? < end_day)
       LIMIT 1`,
    )
      .bind(representativePersonId, organizationPartyId, endDay, startDay)
      .first();
    overlapExists = rows !== null;
  }
  if (overlapExists)
    return new Response(
      'Overlaps a recorded representation period for this person and organization',
      { status: 409 },
    );

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `INSERT INTO representations (
       id, representative_person_id, organization_party_id, scope_kind, start_day, end_day, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
         SELECT 1 FROM people p JOIN parties pt ON pt.id = p.party_id
         WHERE p.party_id = ? AND pt.consolidated_into_party_id IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM organizations o JOIN parties pt2 ON pt2.id = o.party_id
         WHERE o.party_id = ? AND pt2.consolidated_into_party_id IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM representations
         WHERE representative_person_id = ? AND organization_party_id = ? AND voided_at IS NULL
           AND end_day IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM representations
         WHERE representative_person_id = ? AND organization_party_id = ? AND voided_at IS NULL
           AND start_day < ? AND (end_day IS NULL OR ? < end_day)
       )`,
  ).bind(
    id,
    representativePersonId,
    organizationPartyId,
    scopeResult.value.scopeKind,
    startDay,
    endDay,
    nowMs,
    nowMs,
    representativePersonId,
    organizationPartyId,
    representativePersonId,
    organizationPartyId,
    representativePersonId,
    organizationPartyId,
    endDay ?? '9999-12-31',
    startDay,
  );

  const ctx = await resolveAuthContext(locals, request, env);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-representations', 'create'),
    actorAccountId: ctx?.userId ?? 'unknown',
    nowMs,
  });
  correlation.event({
    kind: 'representation_recorded',
    guard: insertedRowGuard('representations', id),
    detail: {
      family: 'roster_change',
      effective: { day: startDay },
      reason: 'board_recorded',
      evidence: evidenceResult.value,
      subjects: [
        { column: 'representation_id', id, role: 'created' },
        { column: 'party_id', id: organizationPartyId, role: 'related' },
      ],
    },
  });

  const statements = [primary];
  const insertedGuard = insertedRowGuard('representations', id);
  for (const lotId of scopeResult.value.lotIds) {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO representation_lots (representation_id, lot_id, created_at)
         SELECT ?, ?, ? WHERE ${insertedGuard.sql}`,
      ).bind(id, lotId, nowMs, ...insertedGuard.binds),
    );
  }
  statements.push(...correlation.statements);

  let results;
  try {
    results = await env.DATABASE.batch(statements);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response(SUBSTITUTE_FAILED, { status: 409 });
    throw e;
  }
  if (results[0].meta.changes !== 1)
    return new Response('Unable to record representation', { status: 409 });
  return Response.json({ id }, { status: 201 });
}

async function endRepresentation(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const representationId = stringField(body, 'representationId');
  if (!representationId)
    return new Response('representationId is required', { status: 400 });

  const db = getDb(env);
  const existingRows = await db
    .select()
    .from(representations)
    .where(eq(representations.id, representationId))
    .limit(1);
  if (existingRows.length === 0)
    return new Response('Representation not found', { status: 404 });
  const existing = existingRows[0];
  if (existing.voidedAt !== null)
    return new Response('Representation was voided', { status: 409 });
  if (existing.endDay !== null)
    return new Response('Representation already ended', { status: 409 });

  let endDay = associationDay;
  const endDayRaw = stringField(body, 'endDay');
  if (endDayRaw) {
    const endDayResult = isoDateOrError(endDayRaw, 'endDay');
    if (!endDayResult.ok)
      return new Response(endDayResult.error, { status: 400 });
    endDay = endDayResult.value;
  }
  if (endDay <= existing.startDay)
    return new Response('endDay must be after startDay', { status: 400 });

  const substitutionsResult = parseSubstitutions(body);
  if (!substitutionsResult.ok)
    return new Response(substitutionsResult.error, { status: 400 });
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE representations SET end_day = ?, updated_at = ?
     WHERE id = ? AND end_day IS NULL AND voided_at IS NULL`,
  ).bind(endDay, nowMs, representationId);
  const rootGuard = updatedRowGuard('representations', representationId, nowMs);

  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-representations', 'end'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'representation_ended',
    guard: rootGuard,
    detail: {
      family: 'roster_change',
      effective: { day: endDay },
      reason: 'board_recorded',
      evidence: evidenceResult.value,
      subjects: [
        { column: 'representation_id', id: representationId, role: 'ended' },
        {
          column: 'party_id',
          id: existing.organizationPartyId,
          role: 'related',
        },
      ],
    },
  });

  const statements = [primary];
  // A scheduled future end removes no authority today — nothing to run
  // through the consequence engine until that day actually arrives (a later
  // `correctScope`/`void`/another `end` call, or a future re-evaluation).
  if (endDay <= associationDay) {
    const lots = await coveredLots(
      {
        id: existing.id,
        organizationPartyId: existing.organizationPartyId,
        scopeKind: existing.scopeKind,
      },
      associationDay,
    );
    const consequences = await lossConsequences({
      database: env.DATABASE,
      nowMs,
      associationDay,
      effectiveDay: endDay,
      lots,
      rootGuard,
      substitutions: substitutionsResult.value,
      cause: 'representation_ended',
      correlation,
      actorAccountId,
    });
    // Phase 3d (#220): authority loss over the organization's Lots. A
    // Representation change is NOT a transfer, so it never resets a member
    // vote (#220's trigger matrix); it discovers and flags only.
    const effects = await transferEffects({
      database: env.DATABASE,
      nowMs,
      associationDay,
      effectiveDay: endDay,
      lots,
      rootGuard,
      correlation,
      cause: 'representation_ended',
      affectedTermIds: consequences.affectedTermIds,
    });
    statements.push(...consequences.statements);
    statements.push(...effects.statements);
    statements.push(...correlation.statements);
    statements.push(...effects.flagStatements);
    statements.push(
      ...consequences.substitutionAsserts.map((g) =>
        assertInBatch(env.DATABASE, g),
      ),
    );
  } else {
    statements.push(...correlation.statements);
  }

  let results;
  try {
    results = await env.DATABASE.batch(statements);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response(SUBSTITUTE_FAILED, { status: 409 });
    throw e;
  }
  if (results[0].meta.changes !== 1)
    return new Response('Representation already ended or voided', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

async function voidRepresentation(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const representationId = stringField(body, 'representationId');
  if (!representationId)
    return new Response('representationId is required', { status: 400 });

  const db = getDb(env);
  const existingRows = await db
    .select()
    .from(representations)
    .where(eq(representations.id, representationId))
    .limit(1);
  if (existingRows.length === 0)
    return new Response('Representation not found', { status: 404 });
  const existing = existingRows[0];
  if (existing.voidedAt !== null)
    return new Response('Representation already voided', { status: 409 });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE representations SET voided_at = ?, updated_at = ?
     WHERE id = ? AND voided_at IS NULL`,
  ).bind(nowMs, nowMs, representationId);
  const rootGuard = updatedRowGuard('representations', representationId, nowMs);

  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-representations', 'void'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'representation_voided',
    guard: rootGuard,
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'representation_id', id: representationId, role: 'voided' },
        {
          column: 'party_id',
          id: existing.organizationPartyId,
          role: 'related',
        },
      ],
    },
  });

  const lots = await coveredLots(
    {
      id: existing.id,
      organizationPartyId: existing.organizationPartyId,
      scopeKind: existing.scopeKind,
    },
    associationDay,
  );
  const consequences = await lossConsequences({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: associationDay,
    lots,
    rootGuard,
    substitutions: new Map(),
    cause: 'representation_voided',
    correlation,
    actorAccountId,
  });

  // No vote reset (a void is not a transfer), and this command's own open
  // flags resolve as `superseded` rather than being deleted (#204).
  const effects = await transferEffects({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: associationDay,
    lots,
    rootGuard,
    correlation,
    cause: 'representation_voided',
    affectedTermIds: consequences.affectedTermIds,
    supersedes: { column: 'representation_id', id: representationId },
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
    return new Response('Representation already voided', { status: 409 });
  return new Response(null, { status: 204 });
}

async function correctScope(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const representationId = stringField(body, 'representationId');
  if (!representationId)
    return new Response('representationId is required', { status: 400 });

  const db = getDb(env);
  const existingRows = await db
    .select()
    .from(representations)
    .where(eq(representations.id, representationId))
    .limit(1);
  if (existingRows.length === 0)
    return new Response('Representation not found', { status: 404 });
  const existing = existingRows[0];
  const concluded =
    existing.voidedAt !== null ||
    (existing.endDay !== null && existing.endDay <= associationDay);
  if (concluded) return new Response(CONCLUDED, { status: 409 });

  const scopeResult = await validateScope(
    body,
    existing.organizationPartyId,
    associationDay,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const oldLots = await coveredLots(
    {
      id: existing.id,
      organizationPartyId: existing.organizationPartyId,
      scopeKind: existing.scopeKind,
    },
    associationDay,
  );
  const newLots =
    scopeResult.value.scopeKind === 'organization'
      ? await orgCurrentOwnershipLots(
          existing.organizationPartyId,
          associationDay,
        )
      : scopeResult.value.lotIds;
  const removedLots = oldLots.filter((l) => !newLots.includes(l));

  const currentLotRows = await env.DATABASE.prepare(
    `SELECT lot_id FROM representation_lots WHERE representation_id = ? AND voided_at IS NULL`,
  )
    .bind(representationId)
    .all<{ lot_id: string }>();
  const currentLotIds = currentLotRows.results.map((r) => r.lot_id);
  const keepSet = new Set(
    scopeResult.value.scopeKind === 'lots' ? scopeResult.value.lotIds : [],
  );

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE representations SET scope_kind = ?, updated_at = ?
     WHERE id = ? AND voided_at IS NULL AND (end_day IS NULL OR ? < end_day)`,
  ).bind(scopeResult.value.scopeKind, nowMs, representationId, associationDay);
  const rootGuard = updatedRowGuard('representations', representationId, nowMs);

  const statements = [primary];

  // Void every currently-unvoided pair not being kept. Never delete —
  // representation_lots is a retained-and-voided history, like every other
  // roster table.
  for (const lotId of currentLotIds) {
    if (keepSet.has(lotId)) continue;
    statements.push(
      env.DATABASE.prepare(
        `UPDATE representation_lots SET voided_at = ?
         WHERE representation_id = ? AND lot_id = ? AND voided_at IS NULL AND (${rootGuard.sql})`,
      ).bind(nowMs, representationId, lotId, ...rootGuard.binds),
    );
  }
  // Add newly named lots. The (representation_id, lot_id) primary key means a
  // pair can never get a second row: if the pair has never existed, insert;
  // if a past correction voided it, "un-void" it instead — a deliberate
  // correction-of-a-correction, not a resurrection of deleted history (this
  // table never deletes).
  for (const lotId of keepSet) {
    if (currentLotIds.includes(lotId)) continue;
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO representation_lots (representation_id, lot_id, created_at)
         SELECT ?, ?, ?
         WHERE (${rootGuard.sql})
           AND NOT EXISTS (SELECT 1 FROM representation_lots WHERE representation_id = ? AND lot_id = ?)`,
      ).bind(
        representationId,
        lotId,
        nowMs,
        ...rootGuard.binds,
        representationId,
        lotId,
      ),
    );
    statements.push(
      env.DATABASE.prepare(
        `UPDATE representation_lots SET voided_at = NULL
         WHERE representation_id = ? AND lot_id = ? AND voided_at IS NOT NULL AND (${rootGuard.sql})`,
      ).bind(representationId, lotId, ...rootGuard.binds),
    );
  }

  const ctx = await resolveAuthContext(locals, request, env);
  const actorAccountId = ctx?.userId ?? 'unknown';
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-representations', 'correctScope'),
    actorAccountId,
    nowMs,
  });
  const subjects: {
    column: RosterSubjectColumn;
    id: string;
    role: SubjectRole;
  }[] = [
    { column: 'representation_id', id: representationId, role: 'primary' },
    { column: 'party_id', id: existing.organizationPartyId, role: 'related' },
    ...removedLots.map((lotId) => ({
      column: 'lot_id' as const,
      id: lotId,
      role: 'related' as const,
    })),
  ];
  correlation.event({
    kind: 'representation_scope_corrected',
    guard: rootGuard,
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'scope_correction',
      evidence: OPERATOR_OBSERVATION,
      subjects,
    },
  });

  const consequences = await lossConsequences({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: associationDay,
    lots: removedLots,
    rootGuard,
    substitutions: new Map(),
    cause: 'representation_scope_corrected',
    correlation,
    actorAccountId,
  });
  // Only the Lots the correction removed lost authority; the rest are
  // untouched, so discovery and the forward pass run over `removedLots` only.
  const effects = await transferEffects({
    database: env.DATABASE,
    nowMs,
    associationDay,
    effectiveDay: associationDay,
    lots: removedLots,
    rootGuard,
    correlation,
    cause: 'representation_scope_corrected',
    affectedTermIds: consequences.affectedTermIds,
  });
  statements.push(...consequences.statements);
  statements.push(...effects.statements);
  statements.push(...correlation.statements);
  statements.push(...effects.flagStatements);
  statements.push(
    ...consequences.substitutionAsserts.map((g) =>
      assertInBatch(env.DATABASE, g),
    ),
  );

  let results;
  try {
    results = await env.DATABASE.batch(statements);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response(SUBSTITUTE_FAILED, { status: 409 });
    throw e;
  }
  if (results[0].meta.changes !== 1)
    return new Response(CONCLUDED, { status: 409 });
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
      return createRepresentation(
        parsed.value,
        locals,
        request,
        associationDay,
      );
    case 'end':
      return endRepresentation(parsed.value, locals, request, associationDay);
    case 'void':
      return voidRepresentation(parsed.value, locals, request, associationDay);
    case 'correctScope':
      return correctScope(parsed.value, locals, request, associationDay);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
