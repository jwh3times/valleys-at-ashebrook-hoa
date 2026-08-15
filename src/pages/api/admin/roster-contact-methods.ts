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
import { parties, contactMethods } from '../../../server/db/roster-schema';
import {
  normalizeEmail,
  normalizePhone,
} from '../../../server/roster/normalize';
import {
  AuditCorrelation,
  operationKey,
  updatedRowGuard,
  insertedRowGuard,
  OPERATOR_OBSERVATION,
  type SensitiveCategory,
} from '../../../server/roster/audit';

// ADR 0022 phase 3b (#218): board-recorded Contact Methods. Values are
// normalized on write (the verification path matches on value_normalized);
// the ledger records only the CATEGORY of what changed (email / phone), never
// the value. At most one preferred method per party per channel among live
// rows — the partial unique enforces it, so any write that sets a preference
// clears the previous holder in the same batch rather than tripping the
// index.

export const prerender = false;

const CONSOLIDATED =
  'Party has been consolidated — record facts on the survivor';

function normalizedValue(
  channel: 'email' | 'sms',
  value: string,
): { ok: true; value: string } | { ok: false; error: string } {
  // The shared normalizers deliberately do NOT validate — legacy values are
  // accepted as recorded — so a light shape check lives here, where a board
  // member is typing a NEW value and a typo should bounce rather than be
  // enshrined.
  const shapeOk =
    channel === 'email'
      ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
      : value.replace(/\D/g, '').length >= 10;
  const normalized = shapeOk
    ? channel === 'email'
      ? normalizeEmail(value)
      : normalizePhone(value)
    : null;
  if (!normalized)
    return {
      ok: false,
      error:
        channel === 'email' ? 'Invalid email address' : 'Invalid phone number',
    };
  return { ok: true, value: normalized };
}

const category = (channel: 'email' | 'sms'): SensitiveCategory =>
  channel === 'email' ? 'email' : 'phone';

async function actor(
  locals: App.Locals | undefined,
  request: Request,
): Promise<string> {
  const ctx = await resolveAuthContext(locals, request, env);
  return ctx?.userId ?? 'unknown';
}

/** Clears the party+channel's current preferred row so the partial unique
 * admits a new one; gated on the given marker so a lost race clears nothing. */
function clearPreferredStatement(
  partyId: string,
  channel: string,
  nowMs: number,
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `UPDATE contact_methods SET is_preferred = 0, updated_at = ?
     WHERE party_id = ? AND channel = ? AND is_preferred = 1
       AND end_day IS NULL AND voided_at IS NULL`,
  ).bind(nowMs, partyId, channel);
}

async function addContactMethod(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const partyId = stringField(body, 'partyId');
  if (!partyId) return new Response('partyId is required', { status: 400 });
  const [party] = await getDb(env)
    .select()
    .from(parties)
    .where(eq(parties.id, partyId))
    .limit(1);
  if (!party) return new Response('Party not found', { status: 404 });
  if (party.consolidatedIntoPartyId !== null)
    return new Response(CONSOLIDATED, { status: 409 });

  const channel = stringField(body, 'channel');
  if (channel !== 'email' && channel !== 'sms')
    return new Response("channel must be 'email' or 'sms'", { status: 400 });
  const value = stringField(body, 'value');
  if (!value) return new Response('value is required', { status: 400 });
  const normalized = normalizedValue(channel, value);
  if (!normalized.ok) return new Response(normalized.error, { status: 400 });

  let startDay: string | null = null;
  const startDayRaw = stringField(body, 'startDay');
  if (startDayRaw) {
    const result = isoDateOrError(startDayRaw, 'startDay');
    if (!result.ok) return new Response(result.error, { status: 400 });
    if (result.value > associationDay)
      return new Response('startDay may not be in the future', {
        status: 400,
      });
    startDay = result.value;
  }
  const isPreferred =
    (body as Record<string, unknown>).isPreferred === true;

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-contact-methods', 'add'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'contact_method_recorded',
    guard: insertedRowGuard('contact_methods', id),
    sensitive: [category(channel)],
    detail: {
      family: 'roster_change',
      effective: { day: startDay ?? associationDay },
      reason: 'board_recorded',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'contact_method_id', id, role: 'created' },
        { column: 'party_id', id: partyId, role: 'related' },
      ],
    },
  });

  const statements: D1PreparedStatement[] = [];
  if (isPreferred)
    statements.push(clearPreferredStatement(partyId, channel, nowMs));
  statements.push(
    env.DATABASE.prepare(
      `INSERT INTO contact_methods (id, party_id, channel, value, value_normalized, is_preferred, start_day, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM parties WHERE id = ? AND consolidated_into_party_id IS NULL)`,
    ).bind(
      id,
      partyId,
      channel,
      value,
      normalized.value,
      isPreferred ? 1 : 0,
      startDay,
      nowMs,
      nowMs,
      partyId,
    ),
  );
  statements.push(...correlation.statements);

  const results = await env.DATABASE.batch(statements);
  const primaryIndex = isPreferred ? 1 : 0;
  if (results[primaryIndex].meta.changes !== 1)
    return new Response(CONSOLIDATED, { status: 409 });
  return Response.json({ id }, { status: 201 });
}

interface ContactRow {
  id: string;
  partyId: string;
  channel: 'email' | 'sms';
  isPreferred: boolean;
  startDay: string | null;
  endDay: string | null;
  redactedAt: Date | null;
  voidedAt: Date | null;
}

async function loadContact(id: string): Promise<ContactRow | null> {
  const [row] = await getDb(env)
    .select()
    .from(contactMethods)
    .where(eq(contactMethods.id, id))
    .limit(1);
  return (row as ContactRow | undefined) ?? null;
}

async function endContactMethod(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const contactMethodId = stringField(body, 'contactMethodId');
  if (!contactMethodId)
    return new Response('contactMethodId is required', { status: 400 });
  const contact = await loadContact(contactMethodId);
  if (!contact)
    return new Response('Contact method not found', { status: 404 });
  if (contact.voidedAt !== null)
    return new Response('Contact method was voided', { status: 409 });
  if (contact.endDay !== null)
    return new Response('Contact method already ended', { status: 409 });

  let endDay = associationDay;
  const endDayRaw = stringField(body, 'endDay');
  if (endDayRaw) {
    const result = isoDateOrError(endDayRaw, 'endDay');
    if (!result.ok) return new Response(result.error, { status: 400 });
    endDay = result.value;
  }
  if (contact.startDay !== null && endDay <= contact.startDay)
    return new Response('endDay must be after startDay', { status: 400 });

  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-contact-methods', 'end'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'contact_method_ended',
    guard: updatedRowGuard('contact_methods', contactMethodId, nowMs),
    sensitive: [category(contact.channel)],
    detail: {
      family: 'roster_change',
      effective: { day: endDay },
      reason: 'board_recorded',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'contact_method_id', id: contactMethodId, role: 'ended' },
        { column: 'party_id', id: contact.partyId, role: 'related' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE contact_methods SET end_day = ?, is_preferred = 0, updated_at = ?
       WHERE id = ? AND end_day IS NULL AND voided_at IS NULL`,
    ).bind(endDay, nowMs, contactMethodId),
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Contact method already ended', { status: 409 });
  return new Response(null, { status: 204 });
}

async function voidContactMethod(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const contactMethodId = stringField(body, 'contactMethodId');
  if (!contactMethodId)
    return new Response('contactMethodId is required', { status: 400 });
  const contact = await loadContact(contactMethodId);
  if (!contact)
    return new Response('Contact method not found', { status: 404 });
  if (contact.voidedAt !== null)
    return new Response('Contact method already voided', { status: 409 });

  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-contact-methods', 'void'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'contact_method_voided',
    guard: updatedRowGuard('contact_methods', contactMethodId, nowMs),
    sensitive: [category(contact.channel)],
    detail: {
      family: 'roster_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'contact_method_id', id: contactMethodId, role: 'voided' },
        { column: 'party_id', id: contact.partyId, role: 'related' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE contact_methods SET voided_at = ?, is_preferred = 0, updated_at = ?
       WHERE id = ? AND voided_at IS NULL`,
    ).bind(nowMs, nowMs, contactMethodId),
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Contact method already voided', { status: 409 });
  return new Response(null, { status: 204 });
}

async function setPreferred(
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
  associationDay: string,
): Promise<Response> {
  const contactMethodId = stringField(body, 'contactMethodId');
  if (!contactMethodId)
    return new Response('contactMethodId is required', { status: 400 });
  const contact = await loadContact(contactMethodId);
  if (!contact)
    return new Response('Contact method not found', { status: 404 });
  if (contact.voidedAt !== null || contact.endDay !== null)
    return new Response('Only a current contact method can be preferred', {
      status: 409,
    });
  // Idempotent no-op, deliberately without a ledger row: nothing changed, and
  // a ledger event for a non-change would be noise the correction views then
  // have to explain.
  if (contact.isPreferred) return new Response(null, { status: 204 });

  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-contact-methods', 'setPreferred'),
    actorAccountId: await actor(locals, request),
    nowMs,
  });
  correlation.event({
    kind: 'contact_method_preference_set',
    guard: {
      sql: `EXISTS (SELECT 1 FROM contact_methods WHERE id = ? AND updated_at = ? AND is_preferred = 1)`,
      binds: [contactMethodId, nowMs],
    },
    scalars: [
      {
        fieldKey: 'is_preferred',
        valueType: 'boolean',
        old: false,
        new: true,
      },
    ],
    detail: {
      family: 'roster_change',
      effective: { day: associationDay },
      reason: 'board_recorded',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'contact_method_id', id: contactMethodId, role: 'primary' },
        { column: 'party_id', id: contact.partyId, role: 'related' },
      ],
    },
  });

  const results = await env.DATABASE.batch([
    clearPreferredStatement(contact.partyId, contact.channel, nowMs),
    env.DATABASE.prepare(
      `UPDATE contact_methods SET is_preferred = 1, updated_at = ?
       WHERE id = ? AND end_day IS NULL AND voided_at IS NULL`,
    ).bind(nowMs, contactMethodId),
    ...correlation.statements,
  ]);
  if (results[1].meta.changes !== 1)
    return new Response('Only a current contact method can be preferred', {
      status: 409,
    });
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
    case 'add':
      return addContactMethod(parsed.value, locals, request, associationDay);
    case 'end':
      return endContactMethod(parsed.value, locals, request, associationDay);
    case 'void':
      return voidContactMethod(parsed.value, locals, request);
    case 'setPreferred':
      return setPreferred(parsed.value, locals, request, associationDay);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
