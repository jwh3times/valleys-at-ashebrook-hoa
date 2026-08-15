import type { APIRoute } from 'astro';
import { desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import type { AuthContext } from '../../../server/authz/guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import {
  correctionRequests,
  people,
  contactMethods,
} from '../../../server/db/roster-schema';
import {
  AuditCorrelation,
  operationKey,
  updatedRowGuard,
  insertedRowGuard,
  isBatchAssertionError,
  type SqlGuard,
} from '../../../server/roster/audit';
import {
  normalizeName,
  normalizeEmail,
  normalizePhone,
} from '../../../server/roster/normalize';
import { personDisplayLabel, associationDateIso } from '../../../lib/format';

// ADR 0022 phase 3b (#218): the board's review queue for member correction
// requests, and the ONLY writer that turns an accepted request into a fact.
//
// Acceptance is an ordinary Roster Change: it applies the proposed value to
// the domain (a Person's name or a Contact Method) exactly as any other
// board-recorded correction would, citing this request's id as opaque
// evidence (`evidence: { kind: 'request', requestId }`). The request's own
// free text — `proposedValue` and `note` — never enters the ledger; only the
// accepted value itself lands, as the new stored domain value, never as a
// scalar delta or narrative field. A decline writes no ledger row at all.

export const prerender = false;

interface AdminCorrectionRequestRow {
  id: string;
  accountId: string;
  personId: string;
  personDisplayName: string;
  kind: 'name' | 'contact_method';
  contactMethodId: string | null;
  targetChannel: 'email' | 'sms' | null;
  targetCurrentValue: string | null;
  channel: 'email' | 'sms' | null;
  proposedValue: string;
  note: string | null;
  status: 'open' | 'accepted' | 'declined' | 'withdrawn';
  createdAt: number;
  decidedAt: number | null;
  decidedByAccountId: string | null;
}

async function listCorrectionRequests(
  db: Db,
): Promise<AdminCorrectionRequestRow[]> {
  const [requests, personRows, contactRows] = await Promise.all([
    db
      .select()
      .from(correctionRequests)
      .orderBy(desc(correctionRequests.createdAt)),
    db
      .select({ partyId: people.partyId, fullName: people.fullName })
      .from(people),
    db.select().from(contactMethods),
  ]);
  const names = new Map(
    personRows.map((p) => [
      p.partyId,
      personDisplayLabel(p.fullName, p.partyId),
    ]),
  );
  const contacts = new Map(contactRows.map((c) => [c.id, c]));
  return requests.map((r) => {
    const target = r.contactMethodId
      ? contacts.get(r.contactMethodId)
      : undefined;
    return {
      id: r.id,
      accountId: r.accountId,
      personId: r.personId,
      personDisplayName:
        names.get(r.personId) ?? personDisplayLabel(null, r.personId),
      kind: r.kind,
      contactMethodId: r.contactMethodId,
      targetChannel: target ? target.channel : null,
      targetCurrentValue: target
        ? target.redactedAt !== null
          ? null
          : target.value
        : null,
      channel: r.channel,
      proposedValue: r.proposedValue,
      note: r.note,
      status: r.status,
      createdAt: r.createdAt.getTime(),
      decidedAt: r.decidedAt ? r.decidedAt.getTime() : null,
      decidedByAccountId: r.decidedByAccountId,
    };
  });
}

/**
 * Accepts an open request and applies it as one atomic Roster Change.
 *
 * The `correction_requests` status transition — not the domain write — is the
 * PRIMARY: it runs first in the batch and its `meta.changes` decides the 409
 * against a race with a concurrent accept/decline/withdraw. Nothing else here
 * references `correction_requests` by foreign key, so there is no RESTRICT
 * ordering forcing the domain statement first; putting the request update
 * first instead lets one guard — the request's own post-state — cover every
 * domain branch below, rather than re-deriving a separate race guard per
 * branch.
 *
 * A concurrent mutation to the TARGET domain row (a name redaction, a Contact
 * Method voided) between the pre-checks below and the batch is not currently
 * reachable — no other phase-3b route can redact a name or void a Contact
 * Method yet — but if one existed, it could in principle leave the request
 * marked `accepted` while the domain write below no-ops on its own re-checked
 * precondition (and, transitively, the ledger event too, since its guard is
 * the domain write's own success marker). Worth remembering once phase 3d
 * (#220, Roster Redaction) lands a route that can race this one.
 */
async function acceptCorrectionRequest(
  db: Db,
  database: D1Database,
  body: unknown,
  ctx: AuthContext,
): Promise<Response> {
  const requestId = stringField(body, 'requestId');
  if (!requestId) return new Response('requestId is required', { status: 400 });

  const [reqRow] = await db
    .select()
    .from(correctionRequests)
    .where(eq(correctionRequests.id, requestId))
    .limit(1);
  if (!reqRow)
    return new Response('Correction request not found', { status: 404 });
  if (reqRow.status !== 'open')
    return new Response('Request is not open', { status: 409 });

  const nowMs = Date.now();
  const associationDay = associationDateIso();
  const requestGuard: SqlGuard = {
    sql: `EXISTS (SELECT 1 FROM correction_requests WHERE id = ? AND status = 'accepted' AND decided_at = ?)`,
    binds: [requestId, nowMs],
  };
  const requestUpdate = database
    .prepare(
      `UPDATE correction_requests SET status = 'accepted', decided_at = ?, decided_by_account_id = ?
       WHERE id = ? AND status = 'open'`,
    )
    .bind(nowMs, ctx.userId, requestId);

  const domainStatements: D1PreparedStatement[] = [];
  const correlation = new AuditCorrelation(database, {
    operationKey: operationKey('correction-requests', 'accept'),
    actorAccountId: ctx.userId,
    nowMs,
  });

  if (reqRow.kind === 'name') {
    const [person] = await db
      .select({ nameRedactedAt: people.nameRedactedAt })
      .from(people)
      .where(eq(people.partyId, reqRow.personId))
      .limit(1);
    // Unreachable today — person_id is a RESTRICT FK to a real people row —
    // but fail closed rather than throw if that ever stops being true.
    if (!person) return new Response('Person not found', { status: 404 });
    if (person.nameRedactedAt !== null)
      return new Response('Name is redacted and cannot be corrected', {
        status: 409,
      });

    domainStatements.push(
      database
        .prepare(
          `UPDATE people SET full_name = ?, name_normalized = ?, updated_at = ?
           WHERE party_id = ? AND name_redacted_at IS NULL AND (${requestGuard.sql})`,
        )
        .bind(
          reqRow.proposedValue,
          normalizeName(reqRow.proposedValue),
          nowMs,
          reqRow.personId,
          ...requestGuard.binds,
        ),
    );
    correlation.event({
      kind: 'person_name_corrected',
      guard: updatedRowGuard('people', reqRow.personId, nowMs),
      detail: {
        family: 'roster_change',
        effective: 'not_applicable',
        reason: 'correction_request_accepted',
        evidence: { kind: 'request', requestId: reqRow.id },
        subjects: [
          { column: 'party_id', id: reqRow.personId, role: 'primary' },
        ],
      },
      sensitive: ['person_name'],
    });
  } else if (reqRow.contactMethodId) {
    const [target] = await db
      .select()
      .from(contactMethods)
      .where(eq(contactMethods.id, reqRow.contactMethodId))
      .limit(1);
    if (!target)
      return new Response('Contact method not found', { status: 404 });
    if (target.voidedAt !== null || target.redactedAt !== null)
      return new Response(
        'Contact method is voided or redacted and cannot be corrected',
        { status: 409 },
      );
    const normalized =
      target.channel === 'email'
        ? normalizeEmail(reqRow.proposedValue)
        : normalizePhone(reqRow.proposedValue);
    if (!normalized)
      return new Response(
        `Proposed value is not a valid ${target.channel === 'email' ? 'email address' : 'phone number'}`,
        { status: 400 },
      );

    const oldId = target.id;
    const newId = crypto.randomUUID();
    // end_day must exceed start_day (contact_methods_interval_ordered): the
    // later of "today" and "the day after this method started" so a method
    // started today (or even future-started, however unlikely) still ends
    // strictly after it began.
    domainStatements.push(
      database
        .prepare(
          `UPDATE contact_methods
           SET end_day = MAX(?, date(COALESCE(start_day, ?), '+1 day')), is_preferred = 0, updated_at = ?
           WHERE id = ? AND voided_at IS NULL AND redacted_at IS NULL AND (${requestGuard.sql})`,
        )
        .bind(
          associationDay,
          associationDay,
          nowMs,
          oldId,
          ...requestGuard.binds,
        ),
    );
    const oldEndedGuard = updatedRowGuard(
      'contact_methods',
      oldId,
      nowMs,
      ' AND end_day IS NOT NULL',
    );
    domainStatements.push(
      database
        .prepare(
          `INSERT INTO contact_methods (id, party_id, channel, value, value_normalized, is_preferred, start_day, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${oldEndedGuard.sql}`,
        )
        .bind(
          newId,
          reqRow.personId,
          target.channel,
          reqRow.proposedValue,
          normalized,
          target.isPreferred ? 1 : 0,
          associationDay,
          nowMs,
          nowMs,
          ...oldEndedGuard.binds,
        ),
    );
    correlation.event({
      kind: 'contact_method_corrected',
      guard: insertedRowGuard('contact_methods', newId),
      detail: {
        family: 'roster_change',
        effective: { day: associationDay },
        reason: 'correction_request_accepted',
        evidence: { kind: 'request', requestId: reqRow.id },
        subjects: [
          { column: 'contact_method_id', id: oldId, role: 'ended' },
          { column: 'contact_method_id', id: newId, role: 'created' },
          { column: 'party_id', id: reqRow.personId, role: 'primary' },
        ],
      },
      sensitive: [target.channel === 'email' ? 'email' : 'phone'],
    });
  } else if (reqRow.channel) {
    const normalized =
      reqRow.channel === 'email'
        ? normalizeEmail(reqRow.proposedValue)
        : normalizePhone(reqRow.proposedValue);
    if (!normalized)
      return new Response(
        `Proposed value is not a valid ${reqRow.channel === 'email' ? 'email address' : 'phone number'}`,
        { status: 400 },
      );
    const newId = crypto.randomUUID();
    domainStatements.push(
      database
        .prepare(
          `INSERT INTO contact_methods (id, party_id, channel, value, value_normalized, is_preferred, start_day, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, 0, ?, ?, ? WHERE (${requestGuard.sql})`,
        )
        .bind(
          newId,
          reqRow.personId,
          reqRow.channel,
          reqRow.proposedValue,
          normalized,
          associationDay,
          nowMs,
          nowMs,
          ...requestGuard.binds,
        ),
    );
    correlation.event({
      kind: 'contact_method_recorded',
      guard: insertedRowGuard('contact_methods', newId),
      detail: {
        family: 'roster_change',
        effective: { day: associationDay },
        reason: 'correction_request_accepted',
        evidence: { kind: 'request', requestId: reqRow.id },
        subjects: [
          { column: 'contact_method_id', id: newId, role: 'created' },
          { column: 'party_id', id: reqRow.personId, role: 'primary' },
        ],
      },
      sensitive: [reqRow.channel === 'email' ? 'email' : 'phone'],
    });
  } else {
    // Unreachable through the member route, which enforces the XOR at
    // submission time — fail closed rather than guess at an unrecognized
    // shape if a row ever gets here some other way.
    return new Response('Malformed correction request', { status: 400 });
  }

  let results;
  try {
    results = await database.batch([
      requestUpdate,
      ...domainStatements,
      ...correlation.statements,
    ]);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response('Request is not open', { status: 409 });
    throw e;
  }
  if (results[0].meta.changes !== 1)
    return new Response('Request is not open', { status: 409 });
  return new Response(null, { status: 204 });
}

/** Declines an open request. No domain change, no ledger row — a declined
 * request is simply not applied. */
async function declineCorrectionRequest(
  db: Db,
  database: D1Database,
  body: unknown,
  ctx: AuthContext,
): Promise<Response> {
  const requestId = stringField(body, 'requestId');
  if (!requestId) return new Response('requestId is required', { status: 400 });
  const [reqRow] = await db
    .select({ id: correctionRequests.id, status: correctionRequests.status })
    .from(correctionRequests)
    .where(eq(correctionRequests.id, requestId))
    .limit(1);
  if (!reqRow)
    return new Response('Correction request not found', { status: 404 });
  if (reqRow.status !== 'open')
    return new Response('Request is not open', { status: 409 });

  const nowMs = Date.now();
  const result = await database
    .prepare(
      `UPDATE correction_requests SET status = 'declined', decided_at = ?, decided_by_account_id = ?
       WHERE id = ? AND status = 'open'`,
    )
    .bind(nowMs, ctx.userId, requestId)
    .run();
  if (result.meta.changes !== 1)
    return new Response('Request is not open', { status: 409 });
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await listCorrectionRequests(getDb(env)));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const db = getDb(env);
  const action = stringField(parsed.value, 'action');
  switch (action) {
    case 'accept':
      return acceptCorrectionRequest(db, env.DATABASE, parsed.value, ctx);
    case 'decline':
      return declineCorrectionRequest(db, env.DATABASE, parsed.value, ctx);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
