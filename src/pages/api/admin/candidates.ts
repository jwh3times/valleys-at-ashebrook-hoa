import type { APIRoute } from 'astro';
import { desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import { candidates, elections, boardPeople } from '../../../server/db/schema';
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
): Promise<{ found: false } | { found: true; status: string }> {
  const rows = await db
    .select({ status: elections.status })
    .from(elections)
    .where(eq(elections.id, electionId))
    .limit(1);
  if (rows.length === 0) return { found: false };
  return { found: true, status: rows[0].status };
}

/**
 * 400 Response if `boardPersonId` is non-null and does not exist, else
 * null. boardPersonId is a nullable FK to board_people (ON DELETE
 * RESTRICT) — without this pre-check, an unknown id would surface as a raw
 * D1 foreign key error out of the insert/update below, the same failure
 * mode elections.ts's setBallots already guards against for
 * castByOwnerId.
 */
async function checkBoardPersonExists(
  db: Db,
  boardPersonId: string | null | undefined,
): Promise<Response | null> {
  if (!boardPersonId) return null;
  const rows = await db
    .select({ id: boardPeople.id })
    .from(boardPeople)
    .where(eq(boardPeople.id, boardPersonId))
    .limit(1);
  if (rows.length === 0)
    return new Response('Unknown boardPersonId', { status: 400 });
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
  const boardPersonCheck = await checkBoardPersonExists(
    db,
    result.value.boardPersonId,
  );
  if (boardPersonCheck) return boardPersonCheck;

  const existing = await db
    .select({ sequence: candidates.sequence })
    .from(candidates)
    .where(eq(candidates.electionId, electionId))
    .orderBy(desc(candidates.sequence))
    .limit(1);
  const sequence = (existing[0]?.sequence ?? 0) + 1;
  const id = crypto.randomUUID();
  await db.insert(candidates).values({
    id,
    electionId,
    // create mode guarantees fullName is present
    fullName: result.value.fullName!,
    boardPersonId: result.value.boardPersonId ?? null,
    statementMd: result.value.statementMd ?? null,
    sequence,
    votes: null,
    won: false,
    withdrawn: result.value.withdrawn ?? false,
    createdAt: new Date(),
  });
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
    .select({ id: candidates.id, electionId: candidates.electionId })
    .from(candidates)
    .where(eq(candidates.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Candidate not found', { status: 404 });
  const election = await loadElectionStatus(db, existing[0].electionId);
  if (
    election.found &&
    (election.status === 'certified' || election.status === 'void')
  )
    return new Response(CERTIFIED_OR_VOID('this candidate'), { status: 409 });
  const boardPersonCheck = await checkBoardPersonExists(
    db,
    input.boardPersonId,
  );
  if (boardPersonCheck) return boardPersonCheck;
  // A candidate is not moved between elections via PATCH — CandidateInput
  // has no electionId field at all, so a caller supplying one has it
  // silently ignored here, the same treatment motions.ts gives a PATCH that
  // supplies meetingId.
  const set: Record<string, unknown> = {};
  if (input.fullName !== undefined) set.fullName = input.fullName;
  if (input.boardPersonId !== undefined)
    set.boardPersonId = input.boardPersonId;
  if (input.statementMd !== undefined) set.statementMd = input.statementMd;
  if (input.withdrawn !== undefined) set.withdrawn = input.withdrawn;
  await db.update(candidates).set(set).where(eq(candidates.id, id));
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
  if (election.found && election.status !== 'draft')
    return new Response(
      'Only a candidate on a draft election can be deleted — once the election is closed its candidate list is part of the record; mark them withdrawn instead.',
      { status: 409 },
    );
  await db.delete(candidates).where(eq(candidates.id, id));
  return new Response(null, { status: 204 });
};
