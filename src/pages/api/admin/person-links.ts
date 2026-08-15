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
  people,
  personLinks,
  personVerifications,
} from '../../../server/db/roster-schema';
import { personDisplayLabel } from '../../../lib/format';
import {
  isBatchAssertionError,
  operationKey,
  type Evidence,
} from '../../../server/roster/audit';
import {
  manualVerificationStatements,
  endLinkStatements,
  denyIfLastSystemAdministrator,
  type PersonLinkEndReason,
} from '../../../server/roster/identity';

// `self_unlink` is reserved for the applicant's own `/api/verify/unlink` —
// an administrator names a reason for ending someone else's link, so it is
// deliberately excluded from this route's accepted set.
const ADMIN_END_REASONS = new Set<PersonLinkEndReason>([
  'account_replaced',
  'no_longer_qualifies',
  'suspected_compromise',
  'recorded_in_error',
  'resident_request',
]);

// ADR 0022 phase 3c (#219): the board's Person Link surface — manual
// verification (linking an EXISTING Person to an account by board decision)
// and unlink (ending a link and every Access Grant it currently supports).
//
// Identity stays separate from authority: manual verification NEVER creates a
// Person and NEVER touches an Access Grant; unlink only ever ENDS grants the
// account already held, in the same batch as the link ending. Both write the
// new model unconditionally — there is no legacy/derived mode branch here.

export const prerender = false;

const MANUAL_VERIFY_REASONS = new Set([
  'manual_board_decision',
  'migration_reverification',
]);

const EVIDENCE_KINDS = new Set([
  'document',
  'meeting',
  'request',
  'external',
  'operator_observation',
]);

/**
 * Parses `evidence` from the request body into a well-formed `Evidence`
 * value, validated STRICTLY enough that it can never reach
 * `manualVerificationStatements` in a shape that would throw inside the
 * batch build (audit.ts's `evidenceColumns` throws on a malformed evidence
 * value, which would otherwise surface as an uncaught 500 instead of a
 * readable 400).
 */
function parseEvidence(
  body: unknown,
): { ok: true; value: Evidence } | { ok: false; error: string } {
  const record = (body as Record<string, unknown> | null | undefined)?.evidence;
  if (record === null || record === undefined || typeof record !== 'object')
    return { ok: false, error: 'evidence is required' };
  const kind = stringField(record, 'kind');
  if (!EVIDENCE_KINDS.has(kind))
    return {
      ok: false,
      error:
        "evidence.kind must be one of 'document', 'meeting', 'request', 'external', 'operator_observation'",
    };
  const documentId = stringField(record, 'documentId') || null;
  const meetingId = stringField(record, 'meetingId') || null;
  const requestId = stringField(record, 'requestId') || null;
  const externalReference = stringField(record, 'externalReference') || null;
  const refs = [documentId, meetingId, requestId, externalReference];
  const present = refs.filter((r) => r !== null);
  const expected = kind === 'operator_observation' ? 0 : 1;
  if (present.length !== expected)
    return {
      ok: false,
      error: `evidence of kind '${kind}' must carry exactly ${expected} reference`,
    };
  const kindField: Record<string, string | null> = {
    document: documentId,
    meeting: meetingId,
    request: requestId,
    external: externalReference,
  };
  if (kind !== 'operator_observation' && kindField[kind] === null)
    return {
      ok: false,
      error: `evidence.kind '${kind}' requires its matching reference field`,
    };
  return {
    ok: true,
    value: {
      kind: kind as Evidence['kind'],
      documentId,
      meetingId,
      requestId,
      externalReference,
    },
  };
}

interface PersonLinkRow {
  id: string;
  accountId: string;
  accountEmail: string | null;
  accountName: string | null;
  personId: string;
  personDisplayName: string;
  startedAt: number;
  endedAt: number | null;
  endedByAccountId: string | null;
  endReason: string | null;
  current: boolean;
  verification: {
    id: string;
    method: string;
    reason: string | null;
    verifiedAt: number;
    approverAccountId: string | null;
  };
}

async function listPersonLinks(): Promise<PersonLinkRow[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: personLinks.id,
      accountId: personLinks.accountId,
      accountEmail: users.email,
      accountName: users.name,
      personId: personLinks.personId,
      fullName: people.fullName,
      startedAt: personLinks.startedAt,
      endedAt: personLinks.endedAt,
      endedByAccountId: personLinks.endedByAccountId,
      endReason: personLinks.endReason,
      verificationId: personVerifications.id,
      method: personVerifications.method,
      reason: personVerifications.reason,
      verifiedAt: personVerifications.verifiedAt,
      approverAccountId: personVerifications.approverAccountId,
    })
    .from(personLinks)
    .innerJoin(users, eq(users.id, personLinks.accountId))
    .innerJoin(people, eq(people.partyId, personLinks.personId))
    .innerJoin(
      personVerifications,
      eq(personVerifications.id, personLinks.verificationId),
    )
    .orderBy(asc(personLinks.startedAt));

  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    accountEmail: r.accountEmail,
    accountName: r.accountName,
    personId: r.personId,
    personDisplayName: personDisplayLabel(r.fullName, r.personId),
    startedAt: r.startedAt.getTime(),
    endedAt: r.endedAt ? r.endedAt.getTime() : null,
    endedByAccountId: r.endedByAccountId,
    endReason: r.endReason,
    current: r.endedAt === null,
    verification: {
      id: r.verificationId,
      method: r.method,
      reason: r.reason,
      verifiedAt: r.verifiedAt.getTime(),
      approverAccountId: r.approverAccountId,
    },
  }));
}

async function manualVerify(
  body: unknown,
  approverAccountId: string,
): Promise<Response> {
  const accountId = stringField(body, 'accountId');
  if (!accountId) return new Response('accountId is required', { status: 400 });
  const personId = stringField(body, 'personId');
  if (!personId) return new Response('personId is required', { status: 400 });
  const reason = stringField(body, 'reason');
  if (!MANUAL_VERIFY_REASONS.has(reason))
    return new Response(
      "reason must be 'manual_board_decision' or 'migration_reverification'",
      { status: 400 },
    );
  const evidenceResult = parseEvidence(body);
  if (!evidenceResult.ok)
    return new Response(evidenceResult.error, { status: 400 });

  const db = getDb(env);
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  if (!account) return new Response('Account not found', { status: 404 });

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
      and(eq(personLinks.accountId, accountId), isNull(personLinks.endedAt)),
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
    accountId,
    personId,
    approverAccountId,
    reason: reason as 'manual_board_decision' | 'migration_reverification',
    evidence: evidenceResult.value,
    nowMs,
    operationKey: operationKey('person-links', 'manualVerify'),
  });
  const results = await env.DATABASE.batch(batch.statements);
  if (results[0].meta.changes !== 1)
    return new Response('Verification conflicts with the current state', {
      status: 409,
    });
  return Response.json(
    { id: batch.linkId, verificationId: batch.verificationId },
    { status: 201 },
  );
}

async function unlink(
  body: unknown,
  actorAccountId: string,
): Promise<Response> {
  const linkId = stringField(body, 'linkId');
  if (!linkId) return new Response('linkId is required', { status: 400 });
  const endReason = stringField(body, 'endReason');
  if (!ADMIN_END_REASONS.has(endReason as PersonLinkEndReason))
    return new Response(
      'endReason must be one of account_replaced, no_longer_qualifies, suspected_compromise, recorded_in_error, resident_request',
      { status: 400 },
    );

  const db = getDb(env);
  const [link] = await db
    .select()
    .from(personLinks)
    .where(eq(personLinks.id, linkId))
    .limit(1);
  if (!link) return new Response('Link not found', { status: 404 });
  if (link.endedAt !== null)
    return new Response('Link already ended', { status: 409 });

  const nowMs = Date.now();
  if (
    await denyIfLastSystemAdministrator({
      database: env.DATABASE,
      accountId: link.accountId,
      actorAccountId,
      nowMs,
      operationKey: operationKey('person-links', 'lastAdministratorDenied'),
    })
  )
    return new Response('Cannot unlink the last System Administrator', {
      status: 409,
    });

  const statements = await endLinkStatements({
    database: env.DATABASE,
    linkId,
    accountId: link.accountId,
    actorAccountId,
    endReason: endReason as PersonLinkEndReason,
    nowMs,
    operationKey: operationKey('person-links', 'unlink'),
  });
  let results: D1Result[];
  try {
    results = await env.DATABASE.batch(statements);
  } catch (error) {
    // A grant created concurrently with this unlink would have been ended
    // without its caused Access Event; the batch assertion makes that race
    // lose the whole command instead.
    if (isBatchAssertionError(error))
      return new Response('Access changed concurrently — try again', {
        status: 409,
      });
    throw error;
  }
  if (results[0].meta.changes !== 1) {
    if (
      await denyIfLastSystemAdministrator({
        database: env.DATABASE,
        accountId: link.accountId,
        actorAccountId,
        nowMs: Date.now(),
        operationKey: operationKey('person-links', 'lastAdministratorDenied'),
      })
    )
      return new Response('Cannot unlink the last System Administrator', {
        status: 409,
      });
    return new Response('Link is no longer unlinkable', { status: 409 });
  }
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await listPersonLinks());
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
    case 'manualVerify':
      return manualVerify(parsed.value, ctx.userId);
    case 'unlink':
      return unlink(parsed.value, ctx.userId);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
