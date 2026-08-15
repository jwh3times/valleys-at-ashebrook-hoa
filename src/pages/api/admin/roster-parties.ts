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
import {
  parties,
  people,
  organizations,
} from '../../../server/db/roster-schema';
import { normalizeName } from '../../../server/roster/normalize';
import {
  AuditCorrelation,
  operationKey,
  updatedRowGuard,
  insertedRowGuard,
  OPERATOR_OBSERVATION,
  type Evidence,
} from '../../../server/roster/audit';

/** `normalizeName` is nullable for blank input; names here are validated
 * non-blank first, so the fallback only guards the type. */
const normalized = (name: string): string =>
  normalizeName(name) ?? name.toLowerCase();

// ADR 0022 phase 3b (#218): Party identity — creation, name corrections, and
// Duplicate Owner Consolidation (#202, #205).
//
// A Party and its subtype row are created in ONE batch: SQLite cannot enforce
// the parent-to-child direction, so the batch is the enforcement and
// `verify-invariants.ts` the backstop. Organization names are deliberately
// NOT unique — "The Smith Family Trust" can legitimately recur, and
// uniqueness would force a false merge exactly where an audited human
// decision belongs — so a normalized-name collision WARNS on creation
// instead. Consolidation names its survivor explicitly, never by heuristic;
// it refuses when both persons hold current Account links (a System
// Administrator ends one first — Accounts are never combined); and an
// erroneous consolidation is corrected by clearing the pointer, with a reason
// code — there is no `unconsolidate`.
//
// Names travel to the ledger as `audit_sensitive_field_changes` CATEGORIES
// only; no audit table ever stores the value.

export const prerender = false;

const NAME_MAX = 200;

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

function nameField(
  body: unknown,
  key: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = stringField(body, key);
  if (!value) return { ok: false, error: `${key} is required` };
  if (value.length > NAME_MAX)
    return {
      ok: false,
      error: `${key} must be ${NAME_MAX} characters or fewer`,
    };
  return { ok: true, value };
}

async function actor(
  locals: App.Locals | undefined,
  request: Request,
): Promise<string> {
  const ctx = await resolveAuthContext(locals, request, env);
  return ctx?.userId ?? 'unknown';
}

async function createPerson(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const name = nameField(body, 'fullName');
  if (!name.ok) return new Response(name.error, { status: 400 });
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-parties', 'createPerson'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'person_created',
    guard: insertedRowGuard('parties', id),
    sensitive: ['person_name'],
    detail: {
      family: 'roster_change',
      effective: { day: associationDateIso() },
      reason: 'board_recorded',
      evidence: evidenceResult.value,
      subjects: [{ column: 'party_id', id, role: 'created' }],
    },
  });

  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO parties (id, kind, created_at, updated_at) VALUES (?, 'person', ?, ?)`,
    ).bind(id, nowMs, nowMs),
    env.DATABASE.prepare(
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
       VALUES (?, 'person', ?, ?, ?)`,
    ).bind(id, name.value, normalized(name.value), nowMs),
    ...correlation.statements,
  ]);
  return Response.json({ id }, { status: 201 });
}

async function createOrganization(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const legalName = nameField(body, 'legalName');
  if (!legalName.ok) return new Response(legalName.error, { status: 400 });
  const displayNameRaw = stringField(body, 'displayName');
  if (displayNameRaw.length > NAME_MAX)
    return new Response(`displayName must be ${NAME_MAX} characters or fewer`, {
      status: 400,
    });
  const displayName = displayNameRaw || null;
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const nameNormalized = normalized(legalName.value);
  const collisions = await getDb(env)
    .select({ partyId: organizations.partyId })
    .from(organizations)
    .where(eq(organizations.nameNormalized, nameNormalized));

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-parties', 'createOrganization'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'organization_created',
    guard: insertedRowGuard('parties', id),
    detail: {
      family: 'roster_change',
      effective: { day: associationDateIso() },
      reason: 'board_recorded',
      evidence: evidenceResult.value,
      subjects: [{ column: 'party_id', id, role: 'created' }],
    },
  });

  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO parties (id, kind, created_at, updated_at) VALUES (?, 'organization', ?, ?)`,
    ).bind(id, nowMs, nowMs),
    env.DATABASE.prepare(
      `INSERT INTO organizations (party_id, party_kind, legal_name, display_name, name_normalized, updated_at)
       VALUES (?, 'organization', ?, ?, ?, ?)`,
    ).bind(id, legalName.value, displayName, nameNormalized, nowMs),
    ...correlation.statements,
  ]);
  return Response.json(
    collisions.length > 0
      ? {
          id,
          warning:
            'An organization with this name already exists — consolidate through Parties if it is the same entity',
        }
      : { id },
    { status: 201 },
  );
}

async function correctPersonName(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const personId = stringField(body, 'personId');
  if (!personId) return new Response('personId is required', { status: 400 });
  const [person] = await getDb(env)
    .select({ nameRedactedAt: people.nameRedactedAt })
    .from(people)
    .where(eq(people.partyId, personId))
    .limit(1);
  if (!person) return new Response('Person not found', { status: 404 });
  if (person.nameRedactedAt !== null)
    return new Response('Name is redacted and cannot be corrected', {
      status: 409,
    });
  const name = nameField(body, 'fullName');
  if (!name.ok) return new Response(name.error, { status: 400 });
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-parties', 'correctPersonName'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'person_name_corrected',
    guard: updatedRowGuard('people', personId, nowMs),
    sensitive: ['person_name'],
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: evidenceResult.value,
      subjects: [{ column: 'party_id', id: personId, role: 'primary' }],
    },
  });

  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE people SET full_name = ?, name_normalized = ?, updated_at = ?
       WHERE party_id = ? AND name_redacted_at IS NULL`,
    ).bind(name.value, normalized(name.value), nowMs, personId),
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Name is redacted and cannot be corrected', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

async function correctOrganizationName(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const organizationId = stringField(body, 'organizationId');
  if (!organizationId)
    return new Response('organizationId is required', { status: 400 });
  const [org] = await getDb(env)
    .select({ partyId: organizations.partyId })
    .from(organizations)
    .where(eq(organizations.partyId, organizationId))
    .limit(1);
  if (!org) return new Response('Organization not found', { status: 404 });

  const record = body as Record<string, unknown>;
  const hasLegal = 'legalName' in record;
  const hasDisplay = 'displayName' in record;
  if (!hasLegal && !hasDisplay)
    return new Response('No fields to correct', { status: 400 });

  let legalName: string | null = null;
  if (hasLegal) {
    const name = nameField(body, 'legalName');
    if (!name.ok) return new Response(name.error, { status: 400 });
    legalName = name.value;
  }
  let displayName: string | null = null;
  if (hasDisplay && record.displayName !== null) {
    const value = stringField(body, 'displayName');
    if (value.length > NAME_MAX)
      return new Response(
        `displayName must be ${NAME_MAX} characters or fewer`,
        { status: 400 },
      );
    displayName = value || null;
  }

  const nowMs = Date.now();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (hasLegal) {
    sets.push('legal_name = ?', 'name_normalized = ?');
    binds.push(legalName, normalized(legalName!));
  }
  if (hasDisplay) {
    sets.push('display_name = ?');
    binds.push(displayName);
  }
  sets.push('updated_at = ?');
  binds.push(nowMs);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-parties', 'correctOrganizationName'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'organization_name_corrected',
    guard: updatedRowGuard('organizations', organizationId, nowMs),
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: OPERATOR_OBSERVATION,
      subjects: [{ column: 'party_id', id: organizationId, role: 'primary' }],
    },
  });

  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE organizations SET ${sets.join(', ')} WHERE party_id = ?`,
    ).bind(...binds, organizationId),
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Organization not found', { status: 404 });
  return new Response(null, { status: 204 });
}

async function consolidate(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const duplicatePartyId = stringField(body, 'duplicatePartyId');
  const survivorPartyId = stringField(body, 'survivorPartyId');
  if (!duplicatePartyId || !survivorPartyId)
    return new Response('duplicatePartyId and survivorPartyId are required', {
      status: 400,
    });
  if (duplicatePartyId === survivorPartyId)
    return new Response('A party cannot be consolidated into itself', {
      status: 400,
    });

  const db = getDb(env);
  const [duplicate] = await db
    .select()
    .from(parties)
    .where(eq(parties.id, duplicatePartyId))
    .limit(1);
  if (!duplicate) return new Response('Party not found', { status: 404 });
  const [survivor] = await db
    .select()
    .from(parties)
    .where(eq(parties.id, survivorPartyId))
    .limit(1);
  if (!survivor) return new Response('Party not found', { status: 404 });
  if (duplicate.kind !== survivor.kind)
    return new Response('Parties are different kinds', { status: 409 });
  if (duplicate.consolidatedIntoPartyId !== null)
    return new Response('Party is already consolidated', { status: 409 });
  // The one-hop rule: reads canonicalize a single hop, so a survivor that is
  // itself a duplicate would silently strand the chain.
  if (survivor.consolidatedIntoPartyId !== null)
    return new Response(
      'The survivor is itself consolidated — consolidate into its survivor',
      { status: 409 },
    );

  // Persons only: refuse while BOTH hold current Account links. Accounts are
  // never combined; a System Administrator ends one first (#205).
  const bothLinked: { sql: string; binds: unknown[] } = {
    sql: `NOT (
      EXISTS (SELECT 1 FROM person_links WHERE person_id = ? AND ended_at IS NULL)
      AND EXISTS (SELECT 1 FROM person_links WHERE person_id = ? AND ended_at IS NULL)
    )`,
    binds: [duplicatePartyId, survivorPartyId],
  };
  if (duplicate.kind === 'person') {
    const ok = await env.DATABASE.prepare(
      `SELECT CASE WHEN ${bothLinked.sql} THEN 1 ELSE 0 END AS ok`,
    )
      .bind(...bothLinked.binds)
      .first<{ ok: number }>();
    if (ok?.ok !== 1)
      return new Response(
        'Both persons hold current account links — a System Administrator must end one first',
        { status: 409 },
      );
  }

  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const nowMs = Date.now();
  const linkGuardSql =
    duplicate.kind === 'person' ? ` AND ${bothLinked.sql}` : '';
  const linkGuardBinds = duplicate.kind === 'person' ? bothLinked.binds : [];
  const primary = env.DATABASE.prepare(
    `UPDATE parties SET consolidated_into_party_id = ?, updated_at = ?
     WHERE id = ? AND consolidated_into_party_id IS NULL
       AND EXISTS (SELECT 1 FROM parties s WHERE s.id = ? AND s.consolidated_into_party_id IS NULL AND s.kind = ?)${linkGuardSql}`,
  ).bind(
    survivorPartyId,
    nowMs,
    duplicatePartyId,
    survivorPartyId,
    duplicate.kind,
    ...linkGuardBinds,
  );

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-parties', 'consolidate'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'parties_consolidated',
    guard: updatedRowGuard('parties', duplicatePartyId, nowMs),
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'duplicate_consolidation',
      evidence: evidenceResult.value,
      subjects: [
        { column: 'party_id', id: duplicatePartyId, role: 'duplicate' },
        { column: 'party_id', id: survivorPartyId, role: 'survivor' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Consolidation conflicts with the current state', {
      status: 409,
    });
  return new Response(null, { status: 204 });
}

async function correctConsolidation(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const duplicatePartyId = stringField(body, 'duplicatePartyId');
  if (!duplicatePartyId)
    return new Response('duplicatePartyId is required', { status: 400 });
  const [duplicate] = await getDb(env)
    .select()
    .from(parties)
    .where(eq(parties.id, duplicatePartyId))
    .limit(1);
  if (!duplicate) return new Response('Party not found', { status: 404 });
  if (duplicate.consolidatedIntoPartyId === null)
    return new Response('Party is not consolidated', { status: 409 });

  // Clearing the pointer is legitimate because it is CURRENT STATE, not a
  // historical reference — the duplicate's row never moved (#205). The Review
  // Flags for anything that acted under the canonicalized identity in the
  // interim belong to phase 3d's impact discovery (#220), not here.
  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-parties', 'correctConsolidation'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'consolidation_corrected',
    guard: updatedRowGuard('parties', duplicatePartyId, nowMs),
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'consolidation_correction',
      evidence: OPERATOR_OBSERVATION,
      subjects: [{ column: 'party_id', id: duplicatePartyId, role: 'primary' }],
    },
  });

  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE parties SET consolidated_into_party_id = NULL, updated_at = ?
       WHERE id = ? AND consolidated_into_party_id IS NOT NULL`,
    ).bind(nowMs, duplicatePartyId),
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Party is not consolidated', { status: 409 });
  return new Response(null, { status: 204 });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'createPerson':
      return createPerson(parsed.value, locals, request);
    case 'createOrganization':
      return createOrganization(parsed.value, locals, request);
    case 'correctPersonName':
      return correctPersonName(parsed.value, locals, request);
    case 'correctOrganizationName':
      return correctOrganizationName(parsed.value, locals, request);
    case 'consolidate':
      return consolidate(parsed.value, locals, request);
    case 'correctConsolidation':
      return correctConsolidation(parsed.value, locals, request);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
