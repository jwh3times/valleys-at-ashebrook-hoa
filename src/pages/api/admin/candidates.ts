import type { APIRoute } from 'astro';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import { candidates, elections } from '../../../server/db/schema';
import { people, parties } from '../../../server/db/roster-schema';
import { normalizeCandidateInput } from '../../../lib/types';

export const prerender = false;

const CERTIFIED_OR_VOID = (thing: string): string =>
  `Election is certified or void — ${thing} cannot be changed`;

/**
 * Look up an election's status. `found: false` distinguishes "no such
 * election" from any real status value, so callers can tell a 404 apart
 * from a 409 without a second round trip.
 */
async function loadElectionStatus(
  db: Db,
  electionId: string,
): Promise<{ found: false } | { found: true; status: string; source: string }> {
  const rows = await db
    .select({ status: elections.status, source: elections.source })
    .from(elections)
    .where(eq(elections.id, electionId))
    .limit(1);
  if (rows.length === 0) return { found: false };
  return {
    found: true,
    status: rows[0].status,
    source: rows[0].source,
  };
}

/**
 * 400 Response if `personId` is non-null and names no roster Person, else null.
 * `personId` is a nullable FK to `people(party_id)` (ON DELETE RESTRICT) —
 * without this pre-check an unknown id would surface as a raw D1 foreign key
 * error out of the insert/update below, the same failure mode elections.ts's
 * setBallots already guards against for its own actor column.
 *
 * Repointed from `board_people` by #248. A consolidated Party is refused for
 * the same reason the meeting-record picker does not offer one: it is a
 * duplicate that already names its survivor, so recording a candidacy against
 * it would attach the fact to an identity the roster has superseded.
 */
async function checkPersonExists(
  db: Db,
  personId: string | null | undefined,
): Promise<Response | null> {
  if (!personId) return null;
  const rows = await db
    .select({ id: people.partyId })
    .from(people)
    .innerJoin(parties, eq(parties.id, people.partyId))
    .where(
      and(
        eq(people.partyId, personId),
        isNull(parties.consolidatedIntoPartyId),
      ),
    )
    .limit(1);
  if (rows.length === 0)
    return new Response('Unknown personId', { status: 400 });
  return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const electionId = stringField(parsed.value, 'electionId');
  if (!electionId)
    return new Response('electionId is required', { status: 400 });
  const result = normalizeCandidateInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const db = getDb(env);
  const election = await loadElectionStatus(db, electionId);
  if (!election.found)
    return new Response('Election not found', { status: 404 });
  if (election.status === 'certified' || election.status === 'void')
    return new Response(CERTIFIED_OR_VOID('candidates'), { status: 409 });
  if (election.status !== 'draft')
    return new Response(
      'Candidates can be added only while the election is a draft',
      {
        status: 409,
      },
    );
  const personCheck = await checkPersonExists(db, result.value.personId);
  if (personCheck) return personCheck;

  const existing = await db
    .select({ sequence: candidates.sequence })
    .from(candidates)
    .where(eq(candidates.electionId, electionId))
    .orderBy(desc(candidates.sequence))
    .limit(1);
  const sequence = (existing[0]?.sequence ?? 0) + 1;
  const id = crypto.randomUUID();
  const created = await env.DATABASE.prepare(
    `INSERT INTO candidates (
       id, election_id, full_name, person_id, statement_md, sequence,
       votes, won, withdrawn, created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM elections
       WHERE elections.id = ? AND elections.status = 'draft'
     )`,
  )
    .bind(
      id,
      electionId,
      result.value.fullName!,
      result.value.personId ?? null,
      result.value.statementMd ?? null,
      sequence,
      result.value.withdrawn ? 1 : 0,
      Math.floor(Date.now() / 1000),
      electionId,
    )
    .run();
  if (created.meta.changes !== 1)
    return new Response(
      'Candidates can be added only while the election is a draft',
      { status: 409 },
    );
  return Response.json({ id }, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  // The normalizer rejects any payload carrying votes, won, or sequence —
  // those are transition-only (setTallies, certify) or server-assigned.
  const result = normalizeCandidateInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  if (Object.keys(input).length === 0)
    return new Response('No fields to update', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select({
      id: candidates.id,
      electionId: candidates.electionId,
      withdrawn: candidates.withdrawn,
    })
    .from(candidates)
    .where(eq(candidates.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Candidate not found', { status: 404 });
  const election = await loadElectionStatus(db, existing[0].electionId);
  // Fail closed: an election that cannot be resolved must refuse the write,
  // not allow it. Unreachable today since candidates.election_id is a
  // NOT NULL FK to a real election row, but matching POST's existing 404
  // guards against this ever becoming fail-open.
  if (!election.found)
    return new Response('Election not found', { status: 404 });
  if (election.source === 'conducted' && election.status === 'open') {
    const isFirstWithdrawal =
      Object.keys(input).length === 1 &&
      input.withdrawn === true &&
      existing[0].withdrawn === false;
    if (!isFirstWithdrawal)
      return new Response(
        'Only a not-yet-withdrawn candidate may be withdrawn after voting opens',
        { status: 409 },
      );
    const update = await env.DATABASE.prepare(
      `UPDATE candidates
       SET withdrawn = 1
       WHERE id = ? AND withdrawn = 0
         AND EXISTS (
           SELECT 1 FROM elections
           WHERE elections.id = candidates.election_id
             AND elections.source = 'conducted'
             AND elections.status = 'open'
         )`,
    )
      .bind(id)
      .run();
    if (update.meta.changes !== 1)
      return new Response('Candidate can no longer be withdrawn', {
        status: 409,
      });
    return new Response(null, { status: 204 });
  }
  if (election.source === 'conducted' && election.status !== 'draft')
    return new Response(
      'A conducted election candidate cannot be changed after voting opens',
      { status: 409 },
    );
  if (election.status === 'certified' || election.status === 'void')
    return new Response(CERTIFIED_OR_VOID('this candidate'), { status: 409 });
  const personCheck = await checkPersonExists(db, input.personId);
  if (personCheck) return personCheck;
  // A candidate is not moved between elections via PATCH — CandidateInput
  // has no electionId field at all, so a caller supplying one has it
  // silently ignored here, the same treatment motions.ts gives a PATCH that
  // supplies meetingId.
  const set: Record<string, unknown> = {};
  if (input.fullName !== undefined) set.fullName = input.fullName;
  if (input.personId !== undefined) set.personId = input.personId;
  if (input.statementMd !== undefined) set.statementMd = input.statementMd;
  if (input.withdrawn !== undefined) set.withdrawn = input.withdrawn;
  const electionStillEditable =
    election.source === 'conducted'
      ? sql`EXISTS (
          SELECT 1 FROM elections
          WHERE elections.id = ${candidates.electionId}
            AND elections.source = 'conducted'
            AND elections.status = 'draft'
        )`
      : sql`EXISTS (
          SELECT 1 FROM elections
          WHERE elections.id = ${candidates.electionId}
            AND elections.source = 'recorded'
            AND elections.status NOT IN ('certified', 'void')
        )`;
  const updated = await db
    .update(candidates)
    .set(set)
    .where(and(eq(candidates.id, id), electionStillEditable))
    .returning({ id: candidates.id });
  if (updated.length !== 1)
    return new Response('Election candidate configuration is frozen', {
      status: 409,
    });
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select({ id: candidates.id, electionId: candidates.electionId })
    .from(candidates)
    .where(eq(candidates.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Candidate not found', { status: 404 });
  const election = await loadElectionStatus(db, existing[0].electionId);
  // Fail closed, matching the PATCH guard above: an unresolvable election
  // must refuse the delete, not allow it.
  if (!election.found)
    return new Response('Election not found', { status: 404 });
  if (election.status !== 'draft')
    return new Response(
      'Only a candidate on a draft election can be deleted — once the election is closed its candidate list is part of the record; mark them withdrawn instead.',
      { status: 409 },
    );
  const deleted = await db
    .delete(candidates)
    .where(
      and(
        eq(candidates.id, id),
        sql`EXISTS (
          SELECT 1 FROM elections
          WHERE elections.id = ${candidates.electionId}
            AND elections.status = 'draft'
        )`,
      ),
    )
    .returning({ id: candidates.id });
  if (deleted.length !== 1)
    return new Response('Election candidate configuration is frozen', {
      status: 409,
    });
  return new Response(null, { status: 204 });
};
