import type { APIRoute } from 'astro';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { users } from '../../../server/db/auth-schema';
import {
  parties,
  personLinks,
  verificationReviewRequests,
} from '../../../server/db/roster-schema';
import {
  AuditCorrelation,
  insertedRowGuard,
  operationKey,
} from '../../../server/roster/audit';
import { manualVerificationStatements } from '../../../server/roster/identity';

// ADR 0022 phase 3c (#219): the board's verification review queue — the
// applicant-facing `/api/verify/review` (owned elsewhere in this program)
// writes `verification_review_requests`; this route is where the board acts
// on it. `accept` is manual verification whose evidence cites the request's
// own id; `decline` writes NO Person Link and NO Person Verification, only a
// durable Identity Event recording that the request was refused — the free
// text the applicant supplied (`claimed_address`/`claimed_name`) never
// reaches either write.

export const prerender = false;

const DEFAULT_ACCEPT_REASON = 'manual_board_decision';
const ACCEPT_REASONS = new Set([
  'manual_board_decision',
  'migration_reverification',
]);

interface OpenRequestRow {
  id: string;
  accountId: string;
  accountEmail: string | null;
  claimedAddress: string;
  claimedName: string;
  channel: 'email' | 'sms' | null;
  internalReason: string;
  createdAt: number;
}

async function listOpenRequests(): Promise<OpenRequestRow[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: verificationReviewRequests.id,
      accountId: verificationReviewRequests.accountId,
      accountEmail: users.email,
      claimedAddress: verificationReviewRequests.claimedAddress,
      claimedName: verificationReviewRequests.claimedName,
      channel: verificationReviewRequests.channel,
      internalReason: verificationReviewRequests.internalReason,
      createdAt: verificationReviewRequests.createdAt,
    })
    .from(verificationReviewRequests)
    .innerJoin(users, eq(users.id, verificationReviewRequests.accountId))
    .where(eq(verificationReviewRequests.status, 'open'))
    .orderBy(asc(verificationReviewRequests.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() }));
}

async function accept(
  body: unknown,
  approverAccountId: string,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const personId = stringField(body, 'personId');
  if (!personId) return new Response('personId is required', { status: 400 });
  const rawReason = stringField(body, 'reason');
  const reason = rawReason === '' ? DEFAULT_ACCEPT_REASON : rawReason;
  if (!ACCEPT_REASONS.has(reason))
    return new Response(
      "reason must be 'manual_board_decision' or 'migration_reverification'",
      { status: 400 },
    );

  const db = getDb(env);
  const [request] = await db
    .select()
    .from(verificationReviewRequests)
    .where(eq(verificationReviewRequests.id, id))
    .limit(1);
  if (!request) return new Response('Request not found', { status: 404 });
  if (request.status !== 'open')
    return new Response('Request already resolved', { status: 409 });

  const [party] = await db
    .select({
      kind: parties.kind,
      consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
    })
    .from(parties)
    .where(eq(parties.id, personId))
    .limit(1);
  if (!party) return new Response('Person not found', { status: 404 });
  if (party.kind !== 'person')
    return new Response(
      'This party is an Organization — manual verification links a Person',
      { status: 409 },
    );
  if (party.consolidatedIntoPartyId !== null)
    return new Response(
      'This Person has been consolidated into another record',
      { status: 409 },
    );

  const [personLinked] = await db
    .select({ id: personLinks.id })
    .from(personLinks)
    .where(and(eq(personLinks.personId, personId), isNull(personLinks.endedAt)))
    .limit(1);
  if (personLinked)
    return new Response(
      'This Person is already linked to an account — unlink it first',
      { status: 409 },
    );
  const [accountLinked] = await db
    .select({ id: personLinks.id })
    .from(personLinks)
    .where(
      and(
        eq(personLinks.accountId, request.accountId),
        isNull(personLinks.endedAt),
      ),
    )
    .limit(1);
  if (accountLinked)
    return new Response(
      'This account is already linked — it must be unlinked first',
      { status: 409 },
    );

  const nowMs = Date.now();
  const batch = manualVerificationStatements({
    database: env.DATABASE,
    accountId: request.accountId,
    personId,
    approverAccountId,
    reason: reason as 'manual_board_decision' | 'migration_reverification',
    evidence: { kind: 'request', requestId: id },
    nowMs,
    operationKey: operationKey('verification-requests', 'accept'),
    // Couples the whole command to the request STILL being open at the
    // mutation boundary — a lost race against a concurrent accept/decline
    // leaves every table (verification, link, request row) untouched.
    extraGuard: {
      sql: `EXISTS (SELECT 1 FROM verification_review_requests WHERE id = ? AND status = 'open')`,
      binds: [id],
    },
  });
  const verificationGuard = insertedRowGuard(
    'person_verifications',
    batch.verificationId,
  );
  const resolveRequest = env.DATABASE.prepare(
    `UPDATE verification_review_requests
     SET status = 'accepted', resolved_at = ?, resolved_by_account_id = ?
     WHERE id = ? AND status = 'open' AND ${verificationGuard.sql}`,
  ).bind(nowMs, approverAccountId, id, ...verificationGuard.binds);

  const results = await env.DATABASE.batch([
    ...batch.statements,
    resolveRequest,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response(
      'Request could not be accepted — it may have already been resolved, or the account/person state changed',
      { status: 409 },
    );
  return Response.json(
    { linkId: batch.linkId, verificationId: batch.verificationId },
    { status: 201 },
  );
}

async function decline(
  body: unknown,
  actorAccountId: string,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });

  const db = getDb(env);
  const [request] = await db
    .select()
    .from(verificationReviewRequests)
    .where(eq(verificationReviewRequests.id, id))
    .limit(1);
  if (!request) return new Response('Request not found', { status: 404 });
  if (request.status !== 'open')
    return new Response('Request already resolved', { status: 409 });

  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE verification_review_requests
     SET status = 'declined', resolved_at = ?, resolved_by_account_id = ?
     WHERE id = ? AND status = 'open'`,
  ).bind(nowMs, actorAccountId, id);

  const resolvedGuard = {
    sql: `EXISTS (SELECT 1 FROM verification_review_requests WHERE id = ? AND status = 'declined' AND resolved_at = ?)`,
    binds: [id, nowMs] as unknown[],
  };
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('verification-requests', 'decline'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'verification_declined',
    guard: resolvedGuard,
    detail: {
      family: 'identity',
      reason: 'verification_review_declined',
      targetAccountId: request.accountId,
      evidence: { kind: 'request', requestId: id },
    },
  });

  const results = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (results[0].meta.changes !== 1)
    return new Response('Request already resolved', { status: 409 });
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await listOpenRequests());
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'accept':
      return accept(parsed.value, ctx.userId);
    case 'decline':
      return decline(parsed.value, ctx.userId);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
