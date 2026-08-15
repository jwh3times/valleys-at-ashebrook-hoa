import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireApiCapability,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { people, contactMethods } from '../../../server/db/roster-schema';
import { redactionTasks } from '../../../server/db/audit-schema';
import {
  AuditCorrelation,
  updatedRowGuard,
  operationKey,
} from '../../../server/roster/audit';

export const prerender = false;

// Roster Redaction (#205, #217's four System-Administrator-only technical
// capabilities). Two of the three actions here ('redactPersonName',
// 'redactContactMethod') require `redactionAuthorize`; the third
// ('recordCleanup') requires the DIFFERENT, narrower `redactionCleanup`
// capability — recording that a downstream purge succeeded or failed is a
// separate authority from deciding a value should be erased at all.

const AUTHORITY_REFERENCE_MAX = 300;
// A reason CODE, not free text (see AGENTS.md's ledger rules) — short, and
// capped accordingly.
const REASON_MAX = 120;

type AuthorityKind = 'legal_requirement' | 'binding_policy';

interface Authority {
  authorityKind: AuthorityKind;
  authorityReference: string;
  reason: string;
}

function validateAuthority(
  body: unknown,
): { ok: true; value: Authority } | { ok: false; error: string } {
  const authorityKind = stringField(body, 'authorityKind');
  if (
    authorityKind !== 'legal_requirement' &&
    authorityKind !== 'binding_policy'
  )
    return {
      ok: false,
      error: 'authorityKind must be legal_requirement or binding_policy',
    };
  const authorityReference = stringField(body, 'authorityReference');
  if (!authorityReference)
    return { ok: false, error: 'authorityReference is required' };
  if (authorityReference.length > AUTHORITY_REFERENCE_MAX)
    return {
      ok: false,
      error: `authorityReference must be ${AUTHORITY_REFERENCE_MAX} characters or fewer`,
    };
  const reason = stringField(body, 'reason');
  if (!reason) return { ok: false, error: 'reason is required' };
  if (reason.length > REASON_MAX)
    return {
      ok: false,
      error: `reason must be ${REASON_MAX} characters or fewer`,
    };
  return { ok: true, value: { authorityKind, authorityReference, reason } };
}

/**
 * Gated on the just-inserted root event's own id existing. The integrity view
 * (`audit_integrity_violations_v`'s `redaction_incomplete` branch) REQUIRES at
 * least one cleanup task per redaction event, so this statement is not
 * optional bookkeeping — without it every redaction would trip that check.
 */
function redactionTaskStatement(
  rootEventId: string,
  targetIdentifier: string,
  nowMs: number,
) {
  return env.DATABASE.prepare(
    `INSERT INTO redaction_tasks (id, redaction_event_id, target_kind, target_identifier, status, attempts, created_at)
     SELECT ?, ?, 'pseudonymizer_catalog', ?, 'pending', 0, ?
     WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
  ).bind(
    crypto.randomUUID(),
    rootEventId,
    targetIdentifier,
    nowMs,
    rootEventId,
  );
}

async function redactPersonName(
  actorAccountId: string,
  body: unknown,
): Promise<Response> {
  const personId = stringField(body, 'personId');
  const db = getDb(env);
  const [person] = await db
    .select({ nameRedactedAt: people.nameRedactedAt })
    .from(people)
    .where(eq(people.partyId, personId));
  if (!person) return new Response('Person not found', { status: 404 });

  const authority = validateAuthority(body);
  if (!authority.ok) return new Response(authority.error, { status: 400 });

  if (person.nameRedactedAt !== null)
    return new Response('Name already redacted', { status: 409 });

  const nowMs = Date.now();
  const peopleUpdate = env.DATABASE.prepare(
    `UPDATE people SET full_name = NULL, name_normalized = NULL, name_redacted_at = ?, updated_at = ?
     WHERE party_id = ? AND name_redacted_at IS NULL`,
  ).bind(nowMs, nowMs, personId);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('redactions', 'redactPersonName'),
    actorAccountId,
    nowMs,
  });
  const rootEventId = correlation.event({
    kind: 'value_redacted',
    guard: updatedRowGuard('people', personId, nowMs),
    detail: {
      family: 'roster_redaction',
      targetPersonId: personId,
      fieldCategory: 'person_name',
      authorizedByAccountId: actorAccountId,
      authorityKind: authority.value.authorityKind,
      authorityReference: authority.value.authorityReference,
      reason: authority.value.reason,
    },
    sensitive: ['person_name'],
  });

  const results = await env.DATABASE.batch([
    peopleUpdate,
    ...correlation.statements,
    redactionTaskStatement(rootEventId, personId, nowMs),
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Name already redacted', { status: 409 });
  return new Response(null, { status: 204 });
}

async function redactContactMethod(
  actorAccountId: string,
  body: unknown,
): Promise<Response> {
  const contactMethodId = stringField(body, 'contactMethodId');
  const db = getDb(env);
  const [contact] = await db
    .select({
      channel: contactMethods.channel,
      redactedAt: contactMethods.redactedAt,
    })
    .from(contactMethods)
    .where(eq(contactMethods.id, contactMethodId));
  if (!contact)
    return new Response('Contact method not found', { status: 404 });

  const authority = validateAuthority(body);
  if (!authority.ok) return new Response(authority.error, { status: 400 });

  if (contact.redactedAt !== null)
    return new Response('Value already redacted', { status: 409 });

  const fieldCategory: 'email' | 'phone' =
    contact.channel === 'email' ? 'email' : 'phone';
  const nowMs = Date.now();
  // value and value_normalized must go NULL together — the paired CHECKs
  // (contact_methods_value_redaction_paired, contact_methods_normalized_paired)
  // demand it.
  const contactUpdate = env.DATABASE.prepare(
    `UPDATE contact_methods SET value = NULL, value_normalized = NULL, redacted_at = ?, updated_at = ?
     WHERE id = ? AND redacted_at IS NULL`,
  ).bind(nowMs, nowMs, contactMethodId);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('redactions', 'redactContactMethod'),
    actorAccountId,
    nowMs,
  });
  const rootEventId = correlation.event({
    kind: 'value_redacted',
    guard: updatedRowGuard('contact_methods', contactMethodId, nowMs),
    detail: {
      family: 'roster_redaction',
      targetContactMethodId: contactMethodId,
      fieldCategory,
      authorizedByAccountId: actorAccountId,
      authorityKind: authority.value.authorityKind,
      authorityReference: authority.value.authorityReference,
      reason: authority.value.reason,
    },
    sensitive: [fieldCategory],
  });

  const results = await env.DATABASE.batch([
    contactUpdate,
    ...correlation.statements,
    redactionTaskStatement(rootEventId, contactMethodId, nowMs),
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Value already redacted', { status: 409 });
  return new Response(null, { status: 204 });
}

/**
 * Operational state only — NO ledger event. The permanent evidence that a
 * redaction happened is the roster_redaction Audit Event written above; a
 * cleanup task merely tracks whether a downstream store (the pseudonymizer
 * catalog, the RAG corpus, ...) has been purged yet, and task rows are
 * allowed to expire under ordinary operational retention once that work is
 * done.
 */
async function recordCleanup(body: unknown): Promise<Response> {
  const taskId = stringField(body, 'taskId');
  const db = getDb(env);
  const [task] = await db
    .select({ status: redactionTasks.status })
    .from(redactionTasks)
    .where(eq(redactionTasks.id, taskId));
  if (!task) return new Response('Task not found', { status: 404 });

  const status = stringField(body, 'status');
  if (status !== 'succeeded' && status !== 'failed')
    return new Response("status must be 'succeeded' or 'failed'", {
      status: 400,
    });

  if (task.status === 'succeeded')
    return new Response('Task already succeeded', { status: 409 });

  const errorCode = stringField(body, 'errorCode') || null;
  const nowMs = Date.now();
  await env.DATABASE.prepare(
    `UPDATE redaction_tasks
       SET status = ?, attempts = attempts + 1,
           completed_at = CASE WHEN ? = 'succeeded' THEN ? ELSE NULL END,
           last_error_code = ?
     WHERE id = ? AND status <> 'succeeded'`,
  )
    .bind(status, status, nowMs, errorCode, taskId)
    .run();

  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireApiCapability(
    locals,
    request,
    env,
    'redactionAuthorize',
  );
  if (denied) return denied;
  const [compliance, tasks] = await Promise.all([
    env.DATABASE.prepare(
      'SELECT * FROM audit_redaction_compliance_v ORDER BY recorded_at DESC',
    ).all(),
    env.DATABASE.prepare('SELECT * FROM redaction_tasks').all(),
  ]);
  return Response.json({
    compliance: compliance.results,
    tasks: tasks.results,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  // The body must be read to know WHICH action is being requested before we
  // know which capability to guard on. Reading it is not itself a privileged
  // act — readJson never throws, it only ever parses or reports failure — and
  // every path below still guards before any database work runs.
  const parsed = await readJson(request);
  const action = parsed.ok ? stringField(parsed.value, 'action') : '';

  const denied =
    action === 'recordCleanup'
      ? await requireApiCapability(locals, request, env, 'redactionCleanup')
      : await requireApiCapability(locals, request, env, 'redactionAuthorize');
  if (denied) return denied;

  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });

  switch (action) {
    case 'redactPersonName': {
      const ctx = await resolveAuthContext(locals, request, env);
      if (!ctx) return new Response('Unauthorized', { status: 401 });
      return redactPersonName(ctx.userId, parsed.value);
    }
    case 'redactContactMethod': {
      const ctx = await resolveAuthContext(locals, request, env);
      if (!ctx) return new Response('Unauthorized', { status: 401 });
      return redactContactMethod(ctx.userId, parsed.value);
    }
    case 'recordCleanup':
      return recordCleanup(parsed.value);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
