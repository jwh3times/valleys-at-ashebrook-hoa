import type { APIRoute } from 'astro';
import { asc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { associationDateIso } from '../../../lib/format';
import { isoDateOrError, normalizePropertyInput } from '../../../lib/types';
import { lots } from '../../../server/db/schema';
import { normalizeAddress } from '../../../server/roster/normalize';
import {
  AuditCorrelation,
  assertInBatch,
  isBatchAssertionError,
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
// `lots.status` is dual-written to 'inactive': legacy authorization and
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
        SELECT 1 FROM board_terms t
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
    .select({ id: lots.id, retiredAt: lots.retiredAt })
    .from(lots)
    .where(eq(lots.id, lotId))
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
      `SELECT 1 AS one FROM board_terms t
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
    `UPDATE lots SET status = 'inactive', retired_day = ?, retired_at = ?, updated_at = ?
     WHERE id = ? AND retired_at IS NULL AND (${guards.sql})`,
  ).bind(effectiveDay, nowMs, nowSeconds, lotId, ...guards.binds);
  const rootGuard = updatedRowGuard('lots', lotId, nowMs);

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
    .select({ id: lots.id, retiredAt: lots.retiredAt })
    .from(lots)
    .where(eq(lots.id, lotId))
    .limit(1);
  if (lotRows.length === 0)
    return new Response('Lot not found', { status: 404 });
  if (lotRows[0].retiredAt === null)
    return new Response('Lot is not retired', { status: 409 });

  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const primary = env.DATABASE.prepare(
    `UPDATE lots SET status = 'active', retired_day = NULL, retired_at = NULL, updated_at = ?
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
      sql: `EXISTS (SELECT 1 FROM lots WHERE id = ? AND updated_at = ? AND retired_at IS NULL)`,
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

// Recording and editing a Lot (#212, replacing the legacy Homes & owners
// panel). Only the address, unit, and vote weight are editable here: `status`
// follows retirement above, and `notes` is legacy free text the new roster
// deliberately does not carry. The address is masked by the assistant's
// pseudonymizer, so the ledger records only that the address or unit changed
// (`lot_address`); the vote weight is a non-personal scalar, recorded
// old-and-new. A weight change is a board decision taking effect today; an
// address or unit change alone is a correction of what was recorded. Frozen
// eligibility snapshots carry their own weights, so an edit never reaches an
// occasion that has already frozen its eligibility.

// D1 surfaces a UNIQUE failure on the cause chain of the batch error.
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause)
    if (/UNIQUE constraint failed/i.test(e.message)) return true;
  return false;
}

const ADDRESS_TAKEN = 'A lot with this address is already on the roster';

type LotInput = { address?: string; unit?: string | null; voteWeight?: number };

function parseLotInput(
  body: unknown,
  mode: 'create' | 'patch',
): { ok: true; value: LotInput } | { ok: false; error: string } {
  const r = (body ?? {}) as Record<string, unknown>;
  if ('status' in r)
    return { ok: false, error: 'status is set by retiring a lot, not here' };
  if ('notes' in r)
    return { ok: false, error: 'notes are not recorded on the roster' };
  const result = normalizePropertyInput(body, mode);
  if (!result.ok) return result;
  const { address, unit, voteWeight } = result.value;
  return { ok: true, value: { address, unit, voteWeight } };
}

async function actorOf(
  locals: App.Locals | undefined,
  request: Request,
): Promise<string> {
  return (await resolveAuthContext(locals, request, env))?.userId ?? 'unknown';
}

async function createLot(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const input = parseLotInput(body, 'create');
  if (!input.ok) return new Response(input.error, { status: 400 });
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });
  const address = input.value.address!; // create mode guarantees it
  const voteWeight = input.value.voteWeight ?? 1;

  const lotId = crypto.randomUUID();
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-lots', 'create'),
    actorAccountId: await actorOf(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'lot_recorded',
    guard: {
      sql: 'EXISTS (SELECT 1 FROM lots WHERE id = ?)',
      binds: [lotId],
    },
    sensitive: ['lot_address'],
    scalars: [
      {
        fieldKey: 'vote_weight',
        valueType: 'integer',
        old: null,
        new: voteWeight,
      },
    ],
    detail: {
      family: 'roster_change',
      effective: { day: associationDay },
      reason: 'board_recorded',
      evidence: evidenceResult.value,
      subjects: [{ column: 'lot_id', id: lotId, role: 'created' }],
    },
  });

  try {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO lots (id, address, address_normalized, unit, status, vote_weight, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).bind(
        lotId,
        address,
        normalizeAddress(address),
        input.value.unit ?? null,
        voteWeight,
        nowSeconds,
        nowSeconds,
      ),
      ...correlation.statements,
    ]);
  } catch (err) {
    if (isUniqueViolation(err))
      return new Response(ADDRESS_TAKEN, { status: 409 });
    throw err;
  }
  return Response.json({ id: lotId }, { status: 201 });
}

/** What the editor loaded, when it says. Lets a save made from a stale form
 * refuse instead of silently restoring a value someone else just changed. */
function parseExpected(
  body: unknown,
): { address: string; unit: string | null; voteWeight: number } | null {
  const raw = (body as Record<string, unknown> | null | undefined)?.expected;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.address !== 'string' ||
    (r.unit !== null && typeof r.unit !== 'string') ||
    typeof r.voteWeight !== 'number'
  )
    return null;
  return { address: r.address, unit: r.unit, voteWeight: r.voteWeight };
}

const LOT_CHANGED = 'The lot changed or was retired — reload and retry';

async function updateLot(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const lotId = stringField(body, 'lotId');
  if (!lotId) return new Response('lotId is required', { status: 400 });
  const input = parseLotInput(body, 'patch');
  if (!input.ok) return new Response(input.error, { status: 400 });
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const [lot] = await getDb(env)
    .select({
      address: lots.address,
      unit: lots.unit,
      voteWeight: lots.voteWeight,
      retiredAt: lots.retiredAt,
    })
    .from(lots)
    .where(eq(lots.id, lotId))
    .limit(1);
  if (!lot) return new Response('Lot not found', { status: 404 });
  if (lot.retiredAt !== null)
    return new Response('A retired lot cannot be edited', { status: 409 });
  const expected = parseExpected(body);
  if (
    expected &&
    (expected.address !== lot.address ||
      expected.unit !== lot.unit ||
      expected.voteWeight !== lot.voteWeight)
  )
    return new Response(LOT_CHANGED, { status: 409 });

  const next = {
    address: input.value.address ?? lot.address,
    unit: input.value.unit !== undefined ? input.value.unit : lot.unit,
    voteWeight: input.value.voteWeight ?? lot.voteWeight,
  };
  const addressChanged = next.address !== lot.address || next.unit !== lot.unit;
  const weightChanged = next.voteWeight !== lot.voteWeight;
  // Idempotent no-op without a ledger row, as `setPreferred` does: a ledger
  // event for a non-change is noise the correction views must then explain.
  if (!addressChanged && !weightChanged)
    return new Response(null, { status: 204 });

  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-lots', 'update'),
    actorAccountId: await actorOf(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'lot_updated',
    // The post-state itself, not the seconds-resolution `updated_at` alone,
    // so an unrelated write in the same second cannot satisfy the marker.
    guard: {
      sql: `EXISTS (SELECT 1 FROM lots WHERE id = ? AND updated_at = ?
              AND address = ? AND unit IS ? AND vote_weight = ?)`,
      binds: [lotId, nowSeconds, next.address, next.unit, next.voteWeight],
    },
    sensitive: addressChanged ? ['lot_address'] : [],
    scalars: weightChanged
      ? [
          {
            fieldKey: 'vote_weight',
            valueType: 'integer',
            old: lot.voteWeight,
            new: next.voteWeight,
          },
        ]
      : [],
    detail: {
      family: 'roster_change',
      ...(weightChanged
        ? {
            effective: { day: associationDay },
            reason: 'board_recorded' as const,
          }
        : {
            effective: 'not_applicable' as const,
            reason: 'recorded_in_error' as const,
          }),
      evidence: evidenceResult.value,
      subjects: [{ column: 'lot_id', id: lotId, role: 'primary' }],
    },
  });

  try {
    await env.DATABASE.batch([
      // Re-checks retirement and the values the ledger records as "old", so a
      // concurrent edit or retirement loses the command rather than leaving
      // an event whose old weight never existed.
      env.DATABASE.prepare(
        `UPDATE lots
         SET address = ?, address_normalized = ?, unit = ?, vote_weight = ?, updated_at = ?
         WHERE id = ? AND retired_at IS NULL
           AND address = ? AND unit IS ? AND vote_weight = ?`,
      ).bind(
        next.address,
        normalizeAddress(next.address),
        next.unit,
        next.voteWeight,
        nowSeconds,
        lotId,
        lot.address,
        lot.unit,
        lot.voteWeight,
      ),
      // The post-state guard below cannot tell this command's write from an
      // identical one committed first in the same second, so the UPDATE's own
      // effect decides: a batch whose UPDATE changed nothing rolls back whole
      // rather than recording an edit it did not make.
      assertInBatch(env.DATABASE, { sql: 'changes() = 1', binds: [] }),
      ...correlation.statements,
    ]);
  } catch (err) {
    if (isUniqueViolation(err))
      return new Response(ADDRESS_TAKEN, { status: 409 });
    if (isBatchAssertionError(err))
      return new Response(LOT_CHANGED, { status: 409 });
    throw err;
  }
  return new Response(null, { status: 204 });
}

/**
 * The Lot list the admin panels pick from (elections, meetings, proxies,
 * violations, dues). Only what they use, so a picker never carries the
 * legacy `notes` or anything personal. `status` rather than a derived
 * "retired" flag: the election and motion SQL still decides live Lots from
 * `status`, and every writer keeps it in step with retirement.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const rows = await getDb(env)
    .select({
      id: lots.id,
      address: lots.address,
      unit: lots.unit,
      status: lots.status,
      voteWeight: lots.voteWeight,
    })
    .from(lots)
    .orderBy(asc(lots.address));
  return Response.json(rows);
};

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
    case 'create':
      return createLot(parsed.value, locals, request, associationDateIso());
    case 'update':
      return updateLot(parsed.value, locals, request, associationDateIso());
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
